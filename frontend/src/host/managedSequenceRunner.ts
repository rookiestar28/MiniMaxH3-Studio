import { sha256Text } from "../contracts/canonicalFingerprint";
import {
  runnerRequestId,
  safeFailureFingerprint,
  mediaFailureCode,
  validateStartIntent,
  parentAuthority,
  parentProjectionAuthority,
  serialProjectionProgress,
  validateReuseAuthority,
  parentMutationPayload,
} from "./managedSequenceAuthority";
import {
  validatePreparedMediaFailurePayload,
  type SequenceMediaFailureCode,
} from "./managedSequenceClient";
import type {
  ManagedAppModePreflight,
  ManagedAppModeQueueAuthority,
  ManagedAppModeQueueFailureDisposition,
} from "./appMode";
import {
  releaseSequencePayload,
  type SequenceCoordinatorResult,
} from "./sequenceCoordinator";
import type { ExecutionTerminalEvent } from "./sidebarHost";
import type { ManagedSequenceMutationResult } from "./managedSequenceClient";
import {
  ManagedSerialSequenceRunnerError,
  assertManagedSerialSequenceRunnerDependencies,
  type ManagedSerialSequenceRunnerDependencies,
  type ActiveSerialChild,
  type ManagedSerialArtifactObservation,
  type ManagedSerialChildPlan,
  type ManagedSerialReattachResult,
  type ManagedSerialSequenceStartIntent,
  type ParentAuthority,
  type ReattachedTerminal,
} from "./managedSequenceRunnerContract";

import { createSequenceDiagnosticsRecorder } from "./managedSequenceDiagnostics";

const fingerprint = /^sha256:[0-9a-f]{64}$/;

/**
 * Own the browser half of one explicitly authorized serial parent.
 *
 * CRITICAL: this runner never calls ComfyUI's queue transport. Every child goes through the
 * existing App Mode start transaction, and only its managed callbacks advance parent/child
 * authority. Replacing `startChild` with a direct `/prompt` call creates a second queue owner and
 * breaks the exact-once and ambiguity rules this state machine enforces.
 */
export function createManagedSerialSequenceRunner({
  parentClient,
  coordinatorClient,
  reattachStore,
  startChild,
  resolveChild,
  historyClient,
  resolveReuse,
}: ManagedSerialSequenceRunnerDependencies) {
  assertManagedSerialSequenceRunnerDependencies({
    parentClient,
    coordinatorClient,
    reattachStore,
    startChild,
    resolveChild,
    historyClient,
    resolveReuse,
  });

  let authority: ParentAuthority | null = null;
  let active: ActiveSerialChild | null = null;
  let segmentIds: readonly string[] = Object.freeze([]);
  let nextIndex = 0;
  let attached = false;
  let started = false;
  let starting = false;
  let pendingStartIdentity: string | null = null;
  let startAuthorization: ParentAuthority | null = null;
  let expectedSequenceMode: "t2va" | "i2va" | "l2va" | "fl2va" | null = null;
  let reconciledRead = false;
  let effectEpoch = 0;
  let lastSuccessfulTerminalFingerprint: string | null = null;
  let reattachedTerminal: ReattachedTerminal | null = null;
  let boundCanvas: Readonly<{
    parentSequenceId: string;
    workflowAuthority: object;
    activeWorkflowFingerprint: string;
  }> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  // IMPORTANT: updates only observe acknowledged transitions; reading diagnostics here would
  // make observation authorize execution. Only snapshot may consume this per-runner recorder.
  const diagnostics = createSequenceDiagnosticsRecorder();

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };

  const adopt = (result: ManagedSequenceMutationResult): ParentAuthority => {
    const mode =
      result.schema === "h3.context.managed_sequence_result.v2"
        ? result.sequenceTaskMode
        : "t2va";
    if (
      mode === undefined ||
      (expectedSequenceMode !== null && mode !== expectedSequenceMode)
    )
      throw new ManagedSerialSequenceRunnerError("child_authority_mismatch");
    expectedSequenceMode = mode;
    authority = parentAuthority(result);
    // IMPORTANT: a failed claim commits a paused parent without child authority. Adopt that
    // revision and preserve its typed reason before the generic missing-child guard below.
    if (result.failureCode != null)
      throw new ManagedSerialSequenceRunnerError(result.failureCode, result);
    return authority;
  };

  const requireAuthority = (): ParentAuthority => {
    if (authority === null)
      throw new ManagedSerialSequenceRunnerError("sequence_unavailable");
    return authority;
  };

  const failPrepared = async (
    prepared: ManagedSequenceMutationResult,
    phase: string,
    failureCode?: SequenceMediaFailureCode,
  ): Promise<void> => {
    if (prepared.execution === null) return;
    const current = requireAuthority();
    const payload = parentMutationPayload(current, {
      segment_id: prepared.execution.segmentId,
      eligible_execution_fingerprint: prepared.execution.fingerprint,
      failure_fingerprint: safeFailureFingerprint(phase, "not_invoked"),
      ...(failureCode === undefined ? {} : { failure_code: failureCode }),
    });
    validatePreparedMediaFailurePayload(
      payload,
      expectedSequenceMode ?? undefined,
    );
    const result = await parentClient.send(
      runnerRequestId(
        "fail-prepared",
        current.authorizationFingerprint,
        prepared.execution.fingerprint,
      ),
      "fail_prepared_child",
      payload,
    );
    adopt(result);
  };

  const syncParentArtifact = async (
    child: ActiveSerialChild,
    result: SequenceCoordinatorResult,
  ): Promise<void> => {
    if (result.artifactAuthority === null || child.artifactRecordedByParent)
      return;
    const current = requireAuthority();
    const updated = await parentClient.send(
      runnerRequestId(
        "artifact",
        current.authorizationFingerprint,
        child.execution.segmentId,
        child.execution.attemptEpoch,
        child.queuePromptId,
      ),
      "record_artifact",
      parentMutationPayload(current, {
        segment_id: child.execution.segmentId,
        queue_prompt_id: child.queuePromptId,
        artifact_receipt_fingerprint:
          result.artifactAuthority.receiptFingerprint,
        artifact_bytes: result.artifactAuthority.byteLength,
      }),
    );
    adopt(updated);
    child.artifactRecordedByParent = true;
    diagnostics.artifactRecorded();
  };

  let launchNext: () => Promise<void>;

  const finishTerminal = async (
    child: ActiveSerialChild,
    result: SequenceCoordinatorResult,
  ): Promise<void> => {
    const terminal = result.terminalFingerprint ?? child.terminalFingerprint;
    if (child.terminalKind === null || terminal === null)
      throw new ManagedSerialSequenceRunnerError(
        "terminal_authority_unavailable",
      );
    child.terminalFingerprint = terminal;
    if (!child.childReleased) {
      const released = await coordinatorClient.send(
        runnerRequestId("release-child", child.child.runHandle, terminal),
        "release_sequence",
        {
          ...releaseSequencePayload(
            child.child.runHandle,
            "cleanup_terminal",
            result.sequence.state_fingerprint,
            terminal,
          ),
        },
      );
      if (released.disposition !== "released")
        throw new ManagedSerialSequenceRunnerError("child_release_refused");
      child.childReleased = true;
      diagnostics.released();
    }
    const current = requireAuthority();
    const terminalResult = await parentClient.send(
      runnerRequestId(
        "terminal",
        current.authorizationFingerprint,
        child.execution.segmentId,
        child.execution.attemptEpoch,
        child.queuePromptId,
        child.terminalKind,
      ),
      "record_terminal",
      parentMutationPayload(current, {
        segment_id: child.execution.segmentId,
        queue_prompt_id: child.queuePromptId,
        kind: child.terminalKind,
        terminal_fingerprint: terminal,
      }),
    );
    const terminalAuthority = adopt(terminalResult);
    diagnostics.parentTerminalRecorded();
    active = null;
    if (child.terminalKind === "success") {
      lastSuccessfulTerminalFingerprint = terminal;
      nextIndex += 1;
    }
    if (terminalAuthority.state === "succeeded") reattachStore.clear();
    if (terminalAuthority.state === "active" && attached) await launchNext();
  };

  const handleQueueFailure = async (
    child: ActiveSerialChild,
    disposition: ManagedAppModeQueueFailureDisposition,
  ): Promise<void> => {
    const current = requireAuthority();
    if (disposition === "ambiguous") {
      if (child.writtenOwnedProjectionFingerprint === null)
        throw new ManagedSerialSequenceRunnerError("queue_callback_incomplete");
      const result = await parentClient.send(
        runnerRequestId(
          "invocation-unknown",
          current.authorizationFingerprint,
          child.execution.segmentId,
          child.execution.attemptEpoch,
        ),
        "mark_invocation_unknown",
        parentMutationPayload(current, {
          segment_id: child.execution.segmentId,
          child_run_handle: child.child.runHandle,
          timeout_ms: child.timeoutMs,
          active_workflow_fingerprint: child.plan.activeWorkflowFingerprint,
          previous_owned_projection_fingerprint:
            child.plan.previousOwnedProjectionFingerprint,
          written_owned_projection_fingerprint:
            child.writtenOwnedProjectionFingerprint,
        }),
      );
      adopt(result);
      return;
    }
    const result = await parentClient.send(
      runnerRequestId(
        "fail-bound",
        current.authorizationFingerprint,
        child.execution.segmentId,
        child.execution.attemptEpoch,
      ),
      "fail_bound_child",
      parentMutationPayload(current, {
        segment_id: child.execution.segmentId,
        child_run_handle: child.child.runHandle,
        failure_fingerprint: safeFailureFingerprint("queue", disposition),
      }),
    );
    adopt(result);
    active = null;
  };

  launchNext = async (): Promise<void> => {
    if (!attached || nextIndex >= segmentIds.length) return;
    const current = requireAuthority();
    const segmentId = segmentIds[nextIndex]!;
    diagnostics.preparing(nextIndex);
    const reuse =
      resolveReuse === undefined
        ? null
        : await resolveReuse(segmentId, nextIndex);
    if (reuse !== null) {
      validateReuseAuthority(reuse);
      const reused = await parentClient.send(
        runnerRequestId(
          "reuse",
          current.authorizationFingerprint,
          segmentId,
          nextIndex,
          reuse.artifactReceiptFingerprint,
          reuse.terminalFingerprint,
        ),
        "record_reuse",
        parentMutationPayload(current, {
          segment_id: segmentId,
          artifact_receipt_fingerprint: reuse.artifactReceiptFingerprint,
          artifact_bytes: reuse.byteLength,
          terminal_fingerprint: reuse.terminalFingerprint,
        }),
      );
      const reusedAuthority = adopt(reused);
      lastSuccessfulTerminalFingerprint = reuse.terminalFingerprint;
      nextIndex += 1;
      if (reusedAuthority.state === "succeeded") {
        reattachStore.clear();
        return;
      }
      if (reusedAuthority.state !== "active")
        throw new ManagedSerialSequenceRunnerError("sequence_unavailable");
      await launchNext();
      return;
    }
    const prepared = await parentClient.send(
      // IMPORTANT: explicit retry advances parent authority but keeps segment/index unchanged.
      // Bind the prepare ID to that authority; transport replay still reuses one exact payload.
      runnerRequestId(
        "prepare-child",
        current.authorizationFingerprint,
        segmentId,
        nextIndex,
        current.revision,
      ),
      "prepare_sequence_child",
      parentMutationPayload(current, {
        segment_id: segmentId,
        predecessor_terminal_fingerprint:
          nextIndex === 0 ? null : lastSuccessfulTerminalFingerprint,
      }),
    );
    adopt(prepared);
    const expectedPredecessorTerminalFingerprint =
      nextIndex === 0 ? null : lastSuccessfulTerminalFingerprint;
    if (
      prepared.execution === null ||
      prepared.execution.segmentId !== segmentId ||
      prepared.execution.parentSequenceId !== current.parentSequenceId ||
      prepared.execution.parentAuthorizationFingerprint !==
        current.authorizationFingerprint ||
      prepared.execution.slotRevision !== prepared.revision ||
      prepared.execution.predecessorTerminalFingerprint !==
        expectedPredecessorTerminalFingerprint ||
      prepared.contextWorkspaceHandle === null
    ) {
      await failPrepared(prepared, "prepared_authority_drift");
      throw new ManagedSerialSequenceRunnerError("child_authority_mismatch");
    }
    diagnostics.prepared(nextIndex);
    let plan: ManagedSerialChildPlan;
    try {
      plan = await resolveChild(
        prepared.execution,
        prepared.contextWorkspaceHandle,
        nextIndex,
      );
    } catch (error) {
      diagnostics.failure(error);
      await failPrepared(prepared, "resolve_child", mediaFailureCode(error));
      throw error;
    }
    if (
      typeof plan.workflowAuthority !== "object" ||
      plan.workflowAuthority === null ||
      !fingerprint.test(plan.activeWorkflowFingerprint) ||
      !fingerprint.test(plan.previousOwnedProjectionFingerprint)
    ) {
      await failPrepared(prepared, "invalid_child_plan");
      throw new ManagedSerialSequenceRunnerError("child_authority_mismatch");
    }
    let managedPrepared = false;
    let queueFailureHandled = false;
    let queueInvoked = false;
    const prepareManaged = async (
      preflight: ManagedAppModePreflight,
    ): Promise<ManagedAppModeQueueAuthority> => {
      if (!attached)
        throw new ManagedSerialSequenceRunnerError("sequence_unavailable");
      managedPrepared = true;
      const beforeBind = requireAuthority();
      const bound = await parentClient.send(
        runnerRequestId(
          "bind-child",
          beforeBind.authorizationFingerprint,
          prepared.execution!.fingerprint,
        ),
        "bind_prepared_child",
        parentMutationPayload(beforeBind, {
          segment_id: segmentId,
          eligible_execution_fingerprint: prepared.execution!.fingerprint,
          materialization_receipt_fingerprint:
            prepared.execution!.materializationReceiptFingerprint,
          graph_fingerprint: preflight.observation.graph_fingerprint,
          compiled_prompt_fingerprint:
            preflight.observation.compiled_prompt_fingerprint,
          owned_projection_fingerprint:
            preflight.observation.owned_projection_fingerprint,
          previous_owned_projection_fingerprint:
            plan.previousOwnedProjectionFingerprint,
          active_workflow_fingerprint: plan.activeWorkflowFingerprint,
          correlation: {
            schema: "h3.context.managed_child_correlation.v1",
            pending_correlation_id: `managed.pending.${runnerRequestId(
              "correlation",
              prepared.execution!.fingerprint,
            ).slice(-40)}`,
            execution_node_id: preflight.productShellNodeId,
          },
          observation: preflight.observation,
        }),
      );
      const boundAuthority = adopt(bound);
      const childAuthority = bound.childAuthority;
      if (childAuthority === null)
        throw new ManagedSerialSequenceRunnerError("child_authority_mismatch");
      boundCanvas = Object.freeze({
        parentSequenceId: boundAuthority.parentSequenceId,
        workflowAuthority: plan.workflowAuthority,
        activeWorkflowFingerprint: plan.activeWorkflowFingerprint,
      });
      const child: ActiveSerialChild = {
        execution: prepared.execution!,
        child: childAuthority,
        plan,
        coordinator: null,
        queuePromptId: null,
        timeoutMs: preflight.observation.timeout_ms,
        writtenOwnedProjectionFingerprint: null,
        runningChildRecorded: false,
        runningRecorded: false,
        artifactChildRecorded: false,
        artifactRecordedByParent: false,
        terminalChildRecorded: false,
        terminalKind: null,
        terminalFingerprint: null,
        childReleased: false,
      };
      active = child;
      diagnostics.bind(nextIndex);
      return Object.freeze({
        expectedIdentity: Object.freeze({
          graphFingerprint: preflight.observation.graph_fingerprint,
          compiledPromptFingerprint:
            preflight.observation.compiled_prompt_fingerprint,
        }),
        bindCanvasIdentity(identity): void {
          if (identity.workflowAuthority !== plan.workflowAuthority)
            throw new ManagedSerialSequenceRunnerError(
              "workflow_identity_changed",
            );
          child.writtenOwnedProjectionFingerprint =
            preflight.observation.owned_projection_fingerprint;
        },
        onQueueSubmitted(): void {
          queueInvoked = true;
        },
        async onQueueAccepted(result): Promise<void> {
          if (
            child.writtenOwnedProjectionFingerprint === null ||
            result.graphFingerprint !==
              preflight.observation.graph_fingerprint ||
            result.compiledPromptFingerprint !==
              preflight.observation.compiled_prompt_fingerprint ||
            result.ownedProjectionFingerprint !==
              child.writtenOwnedProjectionFingerprint
          )
            throw new ManagedSerialSequenceRunnerError(
              "queue_callback_incomplete",
            );
          child.queuePromptId = result.queuePromptId;
          const submitted = await coordinatorClient.send(
            runnerRequestId(
              "submit-child",
              child.child.runHandle,
              child.execution.attemptEpoch,
              result.queuePromptId,
            ),
            "record_submission",
            {
              run_handle: child.child.runHandle,
              expected_state_fingerprint: child.child.stateFingerprint,
              job_id: child.child.jobId,
              transaction_id: child.child.transactionId,
              graph_fingerprint: result.graphFingerprint,
              compiled_prompt_fingerprint: result.compiledPromptFingerprint,
              queue_prompt_id: result.queuePromptId,
            },
          );
          child.coordinator = submitted;
          const parentBeforeSubmit = requireAuthority();
          const parentSubmitted = await parentClient.send(
            runnerRequestId(
              "submit-parent",
              parentBeforeSubmit.authorizationFingerprint,
              child.execution.segmentId,
              child.execution.attemptEpoch,
              result.queuePromptId,
            ),
            "record_submission",
            parentMutationPayload(parentBeforeSubmit, {
              segment_id: child.execution.segmentId,
              child_run_handle: child.child.runHandle,
              child_state_fingerprint: submitted.sequence.state_fingerprint,
              queue_prompt_id: result.queuePromptId,
              timeout_ms: preflight.observation.timeout_ms,
              active_workflow_fingerprint: child.plan.activeWorkflowFingerprint,
              previous_owned_projection_fingerprint:
                child.plan.previousOwnedProjectionFingerprint,
              written_owned_projection_fingerprint:
                child.writtenOwnedProjectionFingerprint,
            }),
          );
          adopt(parentSubmitted);
        },
        async onQueueFailed(disposition): Promise<void> {
          if (queueFailureHandled) return;
          queueFailureHandled = true;
          await handleQueueFailure(child, disposition);
        },
      });
    };
    const unsafeOptions = plan.options as Record<string, unknown> | undefined;
    if (
      unsafeOptions?.prepareManaged !== undefined ||
      unsafeOptions?.expectedIdentity !== undefined ||
      unsafeOptions?.onQueueSubmitted !== undefined ||
      unsafeOptions?.preparedCanonicalPrompt !== undefined ||
      unsafeOptions?.preparedSequenceMedia !== undefined
    ) {
      await failPrepared(prepared, "reserved_callback_override");
      throw new ManagedSerialSequenceRunnerError("child_authority_mismatch");
    }
    try {
      await startChild(plan.inputs, {
        ...plan.options,
        preparedCanonicalPrompt: plan.canonicalLowering,
        ...(plan.preparedSequenceMedia === undefined
          ? {}
          : { preparedSequenceMedia: plan.preparedSequenceMedia }),
        prepareManaged,
      });
      const child = active;
      if (
        child === null ||
        child.queuePromptId === null ||
        child.coordinator === null
      )
        throw new ManagedSerialSequenceRunnerError("queue_callback_incomplete");
    } catch (error) {
      diagnostics.failure(error);
      if (!queueFailureHandled && active !== null && queueInvoked)
        await handleQueueFailure(active, "ambiguous");
      else if (!queueFailureHandled)
        // CRITICAL: nothing was queued, so this notice is best-effort and must not replace the
        // AppModeError. Never swallow the ambiguous mark above: it guards duplicate submission.
        await (
          active !== null
            ? handleQueueFailure(active, "not_invoked")
            : managedPrepared
              ? undefined
              : failPrepared(prepared, "compile", mediaFailureCode(error))
        )?.catch(() => undefined);
      throw error;
    }
  };

  const start = (intent: ManagedSerialSequenceStartIntent): Promise<void> => {
    // IMPORTANT: decide duplicates now, but deliver their refusal through the existing tail.
    // Early rejection breaks callers awaiting the first transport; rechecking later can authorize another parent.
    if (starting)
      return exclusive(async () => {
        throw new ManagedSerialSequenceRunnerError("already_started");
      });
    starting = true;
    const requestedEffectEpoch = effectEpoch;
    return exclusive(async () => {
      if (started)
        throw new ManagedSerialSequenceRunnerError("already_started");
      validateStartIntent(intent);
      const startIdentity = sha256Text(
        JSON.stringify({
          authorization: intent.authorization,
          qualification: intent.qualificationFingerprint,
          segments: intent.segmentIds,
          mode: intent.sequenceTaskMode ?? "t2va",
        }),
      );
      if (
        pendingStartIdentity !== null &&
        startIdentity !== pendingStartIdentity
      )
        throw new ManagedSerialSequenceRunnerError("invalid_start_intent");
      expectedSequenceMode = intent.sequenceTaskMode ?? "t2va";
      segmentIds = Object.freeze([...intent.segmentIds]);
      if (startAuthorization === null) {
        const authorization = await parentClient.send(
          runnerRequestId(
            "authorize",
            intent.authorization.expected_plan_fingerprint,
            intent.authorization.generation_plan_fingerprint,
          ),
          "authorize_sequence",
          { ...intent.authorization },
        );
        startAuthorization = adopt(authorization);
        pendingStartIdentity = startIdentity;
      }
      const authorized = startAuthorization;
      const startedResult = await parentClient.send(
        runnerRequestId(
          "start",
          authorized.parentSequenceId,
          authorized.authorizationFingerprint,
        ),
        "start_sequence",
        parentMutationPayload(authorized, {
          qualification_fingerprint: intent.qualificationFingerprint,
          ...(intent.mediaBindings === undefined
            ? {}
            : { media_bindings: intent.mediaBindings }),
        }),
      );
      const startedAuthority = adopt(startedResult);
      // IMPORTANT: concrete Start may refuse a file before reserving a run. Keep the same
      // authorization retryable; only a committed Start consumes this runner's start intent.
      started = true;
      attached = requestedEffectEpoch === effectEpoch;
      if (
        startedAuthority.parentExpiresAtEpochMs === null ||
        !reattachStore.replace({
          parentSequenceId: startedAuthority.parentSequenceId,
          readAuthorityFingerprint: startedAuthority.readAuthorityFingerprint,
          expiresAtEpochMs: startedAuthority.parentExpiresAtEpochMs,
        })
      ) {
        attached = false;
        const cancelled = await parentClient.send(
          runnerRequestId(
            "cancel-no-pointer",
            startedAuthority.parentSequenceId,
          ),
          "cancel_sequence",
          parentMutationPayload(startedAuthority),
        );
        adopt(cancelled);
        throw new ManagedSerialSequenceRunnerError("pointer_unavailable");
      }
      // IMPORTANT: pointer persistence is synchronous and complete before this first call can
      // compile, write, or reach App Mode's one queue boundary.
      await launchNext();
    }).finally(() => {
      starting = false;
    });
  };

  const reattach = (): Promise<ManagedSerialReattachResult> =>
    exclusive(async () => {
      attached = false;
      const pointer = reattachStore.read();
      if (pointer === undefined)
        return Object.freeze({
          disposition: "recovery_unavailable" as const,
          parentState: null,
          activePromptId: null,
        });
      const read = await parentClient.read(
        pointer.parentSequenceId,
        pointer.readAuthorityFingerprint,
      );
      if (read.status !== 200 || read.projection === null)
        throw new ManagedSerialSequenceRunnerError("sequence_unavailable");
      const projection = read.projection;
      authority = parentProjectionAuthority(projection, pointer);
      diagnostics.recoverActive(
        projection.slots.findIndex(
          (slot) => slot.segmentId === projection.activeSegmentId,
        ),
      );
      started = true;
      reconciledRead = true;
      const progress = serialProjectionProgress(projection);
      segmentIds = progress.segmentIds;
      nextIndex = progress.nextIndex;
      lastSuccessfulTerminalFingerprint =
        progress.lastSuccessfulTerminalFingerprint;
      if (projection.activeSegmentId === null) {
        return Object.freeze({
          disposition:
            projection.state === "paused_client_absent"
              ? ("resumable" as const)
              : ("current" as const),
          parentState: projection.state,
          activePromptId: null,
        });
      }
      const slot = projection.slots.find(
        (candidate) => candidate.segmentId === projection.activeSegmentId,
      );
      if (slot !== undefined && reattachedTerminal === null)
        diagnostics.recoverGate(
          segmentIds.indexOf(slot.segmentId),
          slot.artifactReceiptFingerprint !== null,
        );
      if (
        slot === undefined ||
        slot.queuePromptId === null ||
        slot.childRunHandle === null ||
        slot.childStateFingerprint === null ||
        historyClient === undefined
      )
        return Object.freeze({
          disposition: "recovery_unavailable" as const,
          parentState: projection.state,
          activePromptId: slot?.queuePromptId ?? null,
        });
      const history = await historyClient.read(slot.queuePromptId);
      // CRITICAL: the route path is not sufficient authority. A compromised or drifting host
      // response that decodes to another prompt must never terminalize the retained child.
      if (history.promptId !== slot.queuePromptId)
        return Object.freeze({
          disposition: "artifact_authority_unavailable" as const,
          parentState: projection.state,
          activePromptId: slot.queuePromptId,
        });
      if (history.disposition === "not_yet_observed")
        return Object.freeze({
          disposition: "waiting_for_current_child" as const,
          parentState: projection.state,
          activePromptId: slot.queuePromptId,
        });
      if (
        history.terminalFingerprint === null ||
        !fingerprint.test(history.terminalFingerprint) ||
        (history.disposition === "succeeded" &&
          slot.artifactReceiptFingerprint === null)
      )
        return Object.freeze({
          disposition: "artifact_authority_unavailable" as const,
          parentState: projection.state,
          activePromptId: slot.queuePromptId,
        });
      const kind =
        history.disposition === "succeeded"
          ? ("success" as const)
          : history.disposition === "failed"
            ? ("error" as const)
            : ("interrupted" as const);
      if (
        reattachedTerminal === null ||
        reattachedTerminal.segmentId !== slot.segmentId ||
        reattachedTerminal.attemptEpoch !== slot.attemptEpoch ||
        reattachedTerminal.runHandle !== slot.childRunHandle ||
        reattachedTerminal.queuePromptId !== slot.queuePromptId ||
        reattachedTerminal.kind !== kind
      ) {
        const result = await coordinatorClient.send(
          runnerRequestId(
            "reconcile-terminal-child",
            slot.childRunHandle,
            slot.attemptEpoch,
            slot.queuePromptId,
            kind,
            history.terminalFingerprint,
          ),
          "record_terminal",
          {
            run_handle: slot.childRunHandle,
            expected_state_fingerprint: slot.childStateFingerprint,
            queue_prompt_id: slot.queuePromptId,
            kind,
          },
        );
        if (
          result.terminalFingerprint === null ||
          (kind === "success" &&
            (result.artifactAuthority === null ||
              result.artifactAuthority.receiptFingerprint !==
                slot.artifactReceiptFingerprint))
        )
          return Object.freeze({
            disposition: "artifact_authority_unavailable" as const,
            parentState: projection.state,
            activePromptId: slot.queuePromptId,
          });
        reattachedTerminal = {
          segmentId: slot.segmentId,
          attemptEpoch: slot.attemptEpoch,
          runHandle: slot.childRunHandle,
          queuePromptId: slot.queuePromptId,
          kind,
          result,
          childReleased: false,
        };
        diagnostics.recoverGate(
          segmentIds.indexOf(slot.segmentId),
          slot.artifactReceiptFingerprint !== null,
          true,
        );
      }
      const terminal = reattachedTerminal;
      if (!terminal.childReleased) {
        const released = await coordinatorClient.send(
          runnerRequestId(
            "reconcile-release-child",
            terminal.runHandle,
            terminal.result.terminalFingerprint,
          ),
          "release_sequence",
          {
            ...releaseSequencePayload(
              terminal.runHandle,
              "cleanup_terminal",
              terminal.result.sequence.state_fingerprint,
              terminal.result.terminalFingerprint!,
            ),
          },
        );
        if (released.disposition !== "released")
          throw new ManagedSerialSequenceRunnerError("child_release_refused");
        terminal.childReleased = true;
        diagnostics.released();
      }
      const current = requireAuthority();
      const parentTerminal = await parentClient.send(
        runnerRequestId(
          "reconcile-terminal-parent",
          current.authorizationFingerprint,
          terminal.segmentId,
          terminal.attemptEpoch,
          terminal.queuePromptId,
          terminal.kind,
        ),
        "record_terminal",
        parentMutationPayload(current, {
          segment_id: terminal.segmentId,
          queue_prompt_id: terminal.queuePromptId,
          kind: terminal.kind,
          terminal_fingerprint: terminal.result.terminalFingerprint,
        }),
      );
      const completed = adopt(parentTerminal);
      diagnostics.parentTerminalRecorded();
      diagnostics.clearRecoveredActive();
      if (terminal.kind === "success") {
        lastSuccessfulTerminalFingerprint = terminal.result.terminalFingerprint;
        const completedIndex = projection.slots.findIndex(
          (candidate) => candidate.segmentId === terminal.segmentId,
        );
        nextIndex = completedIndex + 1;
      }
      reattachedTerminal = null;
      return Object.freeze({
        disposition: "terminal_reconciled" as const,
        parentState: completed.state,
        activePromptId: null,
      });
    });

  const resume = (identity: {
    activeWorkflowFingerprint: string;
    ownedProjectionFingerprint: string;
  }): Promise<void> => {
    const requestedEffectEpoch = effectEpoch;
    return exclusive(async () => {
      if (
        !reconciledRead ||
        !fingerprint.test(identity.activeWorkflowFingerprint) ||
        !fingerprint.test(identity.ownedProjectionFingerprint)
      )
        throw new ManagedSerialSequenceRunnerError("sequence_unavailable");
      const current = requireAuthority();
      const resumed = await parentClient.send(
        runnerRequestId(
          "resume",
          current.parentSequenceId,
          current.revision,
          identity.activeWorkflowFingerprint,
          identity.ownedProjectionFingerprint,
        ),
        "resume_sequence",
        parentMutationPayload(current, {
          active_workflow_fingerprint: identity.activeWorkflowFingerprint,
          owned_projection_fingerprint: identity.ownedProjectionFingerprint,
        }),
      );
      const resumedAuthority = adopt(resumed);
      reconciledRead = false;
      if (resumedAuthority.state === "succeeded") {
        reattachStore.clear();
        return;
      }
      if (resumedAuthority.state !== "active")
        throw new ManagedSerialSequenceRunnerError("sequence_unavailable");
      // CRITICAL: host/view loss may win while the resume CAS is awaiting the backend. Never let
      // its later response restore browser effect authority or schedule a successor.
      attached = requestedEffectEpoch === effectEpoch;
      await launchNext();
    });
  };

  const recordRunning = (promptId: string): Promise<void> =>
    exclusive(async () => {
      const child = active;
      if (
        child === null ||
        child.coordinator === null ||
        child.queuePromptId === null ||
        promptId !== child.queuePromptId
      )
        return;
      if (child.runningRecorded) return;
      // CRITICAL: independent output roots can deliver ProductShell's running hint after accepted
      // artifact or terminal progress. Never send a backward transition for that same child.
      if (child.artifactChildRecorded || child.terminalChildRecorded) return;
      let running = child.coordinator;
      if (!child.runningChildRecorded) {
        running = await coordinatorClient.send(
          runnerRequestId(
            "running-child",
            child.child.runHandle,
            child.execution.attemptEpoch,
            child.queuePromptId,
          ),
          "record_running",
          {
            run_handle: child.child.runHandle,
            expected_state_fingerprint:
              child.coordinator.sequence.state_fingerprint,
            queue_prompt_id: child.queuePromptId,
            host_owner_id: child.queuePromptId,
          },
        );
        child.coordinator = running;
        child.runningChildRecorded = true;
      }
      const current = requireAuthority();
      adopt(
        await parentClient.send(
          runnerRequestId(
            "running-parent",
            current.authorizationFingerprint,
            child.execution.segmentId,
            child.execution.attemptEpoch,
            child.queuePromptId,
          ),
          "record_running",
          parentMutationPayload(current, {
            segment_id: child.execution.segmentId,
            queue_prompt_id: child.queuePromptId,
            child_state_fingerprint: running.sequence.state_fingerprint,
          }),
        ),
      );
      child.runningRecorded = true;
    });

  const recordArtifact = (
    observation: ManagedSerialArtifactObservation,
  ): Promise<void> =>
    exclusive(async () => {
      const child = active;
      if (
        child === null ||
        child.coordinator === null ||
        child.queuePromptId === null ||
        observation.promptId !== child.queuePromptId
      )
        return;
      let result = child.coordinator;
      if (!child.artifactChildRecorded) {
        result = await coordinatorClient.send(
          runnerRequestId(
            "artifact-child",
            child.child.runHandle,
            child.execution.attemptEpoch,
            child.queuePromptId,
          ),
          "record_artifact",
          {
            run_handle: child.child.runHandle,
            expected_state_fingerprint:
              child.coordinator.sequence.state_fingerprint,
            queue_prompt_id: child.queuePromptId,
            output_node_id: observation.outputNodeId,
            locator: observation.locator,
          },
        );
        child.coordinator = result;
        child.artifactChildRecorded = true;
      }
      diagnostics.fingerprintObserved(result.terminalFingerprint !== null);
      await syncParentArtifact(child, result);
      if (result.terminalFingerprint !== null) {
        await finishTerminal(child, result);
      }
    });

  const recordTerminal = (observation: ExecutionTerminalEvent): Promise<void> =>
    exclusive(async () => {
      const child = active;
      if (
        child === null ||
        child.coordinator === null ||
        child.queuePromptId === null ||
        observation.promptId !== child.queuePromptId
      )
        return;
      const kind = observation.kind;
      if (child.terminalKind !== null && child.terminalKind !== kind)
        throw new ManagedSerialSequenceRunnerError("child_authority_mismatch");
      child.terminalKind = kind;
      let result = child.coordinator;
      if (!child.terminalChildRecorded) {
        result = await coordinatorClient.send(
          runnerRequestId(
            "terminal-child",
            child.child.runHandle,
            child.execution.attemptEpoch,
            child.queuePromptId,
            kind,
          ),
          "record_terminal",
          {
            run_handle: child.child.runHandle,
            expected_state_fingerprint:
              child.coordinator.sequence.state_fingerprint,
            queue_prompt_id: child.queuePromptId,
            kind,
          },
        );
        child.coordinator = result;
        child.terminalChildRecorded = true;
      }
      diagnostics.terminalObserved(result.terminalFingerprint !== null);
      await syncParentArtifact(child, result);
      if (result.terminalFingerprint !== null)
        await finishTerminal(child, result);
    });

  const detach = (): Promise<void> => {
    // Stop successor effects synchronously. The backend signals are best-effort and may follow;
    // correctness does not depend on an unload handler delivering them.
    effectEpoch += 1;
    attached = false;
    return exclusive(async () => {
      const current = requireAuthority();
      adopt(
        await parentClient.send(
          runnerRequestId(
            "detach-parent",
            current.parentSequenceId,
            current.revision,
          ),
          "detach_client",
          parentMutationPayload(current),
        ),
      );
      const child = active;
      if (
        child !== null &&
        child.coordinator !== null &&
        child.queuePromptId !== null
      ) {
        child.coordinator = await coordinatorClient.send(
          runnerRequestId(
            "detach-child",
            child.child.runHandle,
            child.queuePromptId,
          ),
          "release_sequence",
          {
            ...releaseSequencePayload(
              child.child.runHandle,
              "detach_client",
              child.coordinator.sequence.state_fingerprint,
            ),
          },
        );
      }
    });
  };

  const cancel = (): Promise<void> => {
    // Cancellation closes successor authority immediately; the accepted child lifecycle may still
    // report its exact terminal and release proof after the parent becomes cancelled.
    effectEpoch += 1;
    attached = false;
    return exclusive(async () => {
      const current = requireAuthority();
      const cancelled = await parentClient.send(
        runnerRequestId("cancel", current.parentSequenceId, current.revision),
        "cancel_sequence",
        parentMutationPayload(current),
      );
      adopt(cancelled);
      if (active === null) reattachStore.clear();
    });
  };

  const retry = (identity: {
    segmentId: string;
    activeWorkflowFingerprint: string;
    ownedProjectionFingerprint: string;
  }): Promise<void> => {
    const requestedEffectEpoch = effectEpoch;
    return exclusive(async () => {
      const requestedIndex = segmentIds.indexOf(identity.segmentId);
      if (
        requestedIndex < 0 ||
        requestedIndex !== nextIndex ||
        !fingerprint.test(identity.activeWorkflowFingerprint) ||
        !fingerprint.test(identity.ownedProjectionFingerprint)
      )
        throw new ManagedSerialSequenceRunnerError("child_authority_mismatch");
      const current = requireAuthority();
      const retried = await parentClient.send(
        runnerRequestId(
          "retry",
          current.parentSequenceId,
          current.revision,
          identity.segmentId,
          identity.activeWorkflowFingerprint,
          identity.ownedProjectionFingerprint,
        ),
        "retry_segment",
        parentMutationPayload(current, {
          segment_id: identity.segmentId,
          active_workflow_fingerprint: identity.activeWorkflowFingerprint,
          owned_projection_fingerprint: identity.ownedProjectionFingerprint,
        }),
      );
      const retriedAuthority = adopt(retried);
      if (retriedAuthority.state !== "active")
        throw new ManagedSerialSequenceRunnerError("sequence_unavailable");
      active = null;
      diagnostics.clearRecoveredActive();
      reconciledRead = false;
      attached = requestedEffectEpoch === effectEpoch;
      await launchNext();
    });
  };

  return Object.freeze({
    start,
    recordRunning,
    recordArtifact,
    recordTerminal,
    reattach,
    resume,
    detach,
    cancel,
    retry,
    // IMPORTANT (B-M2522-RESUME-01): the backend fences resume and retry with the opaque workflow
    // label the parent's children were bound with, never a hash of the canvas now. Only a child
    // bound by this runner establishes it; it is process-local and the reattach pointer carries
    // none, so a runner created after a reload has no label and resume stays unavailable.
    canvasLabel: () =>
      boundCanvas !== null &&
      boundCanvas.parentSequenceId === authority?.parentSequenceId
        ? Object.freeze({
            workflowAuthority: boundCanvas.workflowAuthority,
            activeWorkflowFingerprint: boundCanvas.activeWorkflowFingerprint,
          })
        : null,
    snapshot: () =>
      Object.freeze({
        attached,
        parentSequenceId: authority?.parentSequenceId ?? null,
        parentState: authority?.state ?? null,
        parentRevision: authority?.revision ?? null,
        activeSegmentId: active?.execution.segmentId ?? null,
        activeQueuePromptId: active?.queuePromptId ?? null,
        diagnostics: diagnostics.snapshot(
          authority?.state ?? null,
          active === null
            ? null
            : segmentIds.indexOf(active.execution.segmentId),
        ),
      }),
  });
}
