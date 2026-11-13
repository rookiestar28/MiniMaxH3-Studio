import * as failureDiagnostics from "../src/host/managedSequenceDiagnostics";
import { ManagedSerialSequenceRunnerError } from "../src/host/managedSequenceRunnerContract";
import { createPreparedSequenceGraphGuard } from "../src/host/preparedSequenceGraph";
import { observePreparedSequenceMedia } from "../src/host/preparedSequenceObservation";
import {
  sequenceFailureFixture,
  sequenceFailureObserver,
} from "./support/sequenceFailureFixture";
import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_SEQUENCE_ACTION_SCHEMA,
  MANAGED_SEQUENCE_REATTACH_STORAGE_KEY,
  createBrowserManagedSequenceReattachStore,
  createManagedSequenceClient,
  createManagedSequenceReattachStore,
  createManagedSerialSequenceRunner,
  decodeManagedSequenceMutationResult,
  decodeManagedSequenceProjection,
  type EligibleSegmentExecution,
  type ManagedSequenceMutationResult,
  type ManagedSequenceProjection,
} from "../src/host/managedSequence";
import type {
  AppModeInputs,
  AppModeStartOptions,
  AppModeStartResult,
  ManagedAppModePreflight,
} from "../src/host/appMode";
import type { SequenceCoordinatorResult } from "../src/host/sequenceCoordinator";
import { SequenceMediaBindingError } from "../src/host/sequenceMediaBindings";
import { AppModeError } from "../src/host/appModeContract";
import {
  emptySequenceGate,
  sequenceChildOrdinal,
  sequenceDiagnosticFailure,
} from "../src/host/managedSequenceDiagnostics";

const fingerprint = (digit: string) => `sha256:${digit.repeat(64)}`;
const parentSequenceId = "managed.sequence.1";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function mutationWire() {
  return {
    schema: "h3.context.managed_sequence_result.v1",
    parent_sequence_id: parentSequenceId,
    authorization_fingerprint: fingerprint("1"),
    read_authority_fingerprint: fingerprint("2"),
    state: "active",
    revision: 1,
    execution: null,
    execution_fingerprint: null,
    child_authority: null,
    context_workspace_handle: null,
    parent_expires_at_epoch_ms: 87_400_000,
    replayed: false,
  };
}

function projectionWire() {
  return {
    schema: "h3.context.managed_sequence_projection.v1",
    parent_sequence_id: parentSequenceId,
    authorization_fingerprint: fingerprint("1"),
    state: "active",
    revision: 1,
    etag: fingerprint("3"),
    lease: {
      schema: "h3.context.managed_sequence_lease.v1",
      created_at: "4059000000000000",
      idle_deadline: "409f400000000000",
      active_deadline: null,
      absolute_deadline: "40f51f4000000000",
      idle_expiry_handled: false,
    },
    active_segment_id: null,
    slots: [
      {
        schema: "h3.context.managed_sequence_slot.v1",
        segment_id: "segment.1",
        ordinal: 1,
        state: "eligible",
        attempt_epoch: 1,
        eligible_execution_fingerprint: null,
        child_run_handle: null,
        child_state_fingerprint: null,
        graph_fingerprint: null,
        compiled_prompt_fingerprint: null,
        canvas_write_fingerprint: null,
        queue_prompt_id: null,
        artifact_receipt_fingerprint: null,
        terminal_fingerprint: null,
      },
    ],
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function mutationResult(
  revision: number,
  state:
    | "authorized"
    | "active"
    | "paused_client_absent"
    | "paused_failure"
    | "paused_unknown_ownership"
    | "cancelled"
    | "succeeded",
  execution: EligibleSegmentExecution | null = null,
  childAuthority: ManagedSequenceMutationResult["childAuthority"] = null,
): ManagedSequenceMutationResult {
  return Object.freeze({
    schema: "h3.context.managed_sequence_result.v1",
    parentSequenceId,
    authorizationFingerprint: fingerprint("1"),
    readAuthorityFingerprint: fingerprint("2"),
    state,
    revision,
    execution,
    childAuthority,
    contextWorkspaceHandle: execution === null ? null : `ws_${"c".repeat(40)}`,
    parentExpiresAtEpochMs: 87_400_000,
    replayed: false,
  });
}

function execution(
  segmentId: string,
  revision: number,
  predecessorTerminalFingerprint: string | null = null,
): EligibleSegmentExecution {
  return Object.freeze({
    parentSequenceId,
    parentAuthorizationFingerprint: fingerprint("1"),
    segmentId,
    slotRevision: revision,
    attemptEpoch: 1,
    materializationReceiptFingerprint: fingerprint("3"),
    predecessorTerminalFingerprint,
    requestId: `prepare.${segmentId}`,
    jobCount: 1,
    fingerprint: fingerprint("4"),
  });
}

function detachedProjection(
  firstState: "submitted" | "artifact_verified" = "submitted",
): ManagedSequenceProjection {
  return Object.freeze({
    schema: "h3.context.managed_sequence_projection.v1",
    parentSequenceId,
    authorizationFingerprint: fingerprint("1"),
    state: "paused_client_absent",
    revision: 6,
    etag: fingerprint("6"),
    lease: Object.freeze({
      createdAt: "4059000000000000",
      idleDeadline: "409f400000000000",
      activeDeadline: "40b3880000000000",
      absoluteDeadline: "40f51f4000000000",
      idleExpiryHandled: false,
    }),
    activeSegmentId: "segment.1",
    slots: Object.freeze([
      Object.freeze({
        segmentId: "segment.1",
        ordinal: 1,
        state: firstState,
        attemptEpoch: 1,
        eligibleExecutionFingerprint: fingerprint("4"),
        childRunHandle: `mc_${"1".repeat(40)}`,
        childStateFingerprint: fingerprint("5"),
        graphFingerprint: fingerprint("6"),
        compiledPromptFingerprint: fingerprint("7"),
        canvasWriteFingerprint: fingerprint("8"),
        queuePromptId: "prompt.1",
        artifactReceiptFingerprint:
          firstState === "artifact_verified" ? fingerprint("a") : null,
        terminalFingerprint: null,
      }),
      Object.freeze({
        segmentId: "segment.2",
        ordinal: 2,
        state: "pending",
        attemptEpoch: 1,
        eligibleExecutionFingerprint: null,
        childRunHandle: null,
        childStateFingerprint: null,
        graphFingerprint: null,
        compiledPromptFingerprint: null,
        canvasWriteFingerprint: null,
        queuePromptId: null,
        artifactReceiptFingerprint: null,
        terminalFingerprint: null,
      }),
    ]),
  });
}

function detachedFailureProjection(): ManagedSequenceProjection {
  const projection = detachedProjection();
  return Object.freeze({
    ...projection,
    state: "paused_failure" as const,
    activeSegmentId: null,
    slots: Object.freeze([
      Object.freeze({
        ...projection.slots[0]!,
        state: "failed",
        terminalFingerprint: fingerprint("f"),
      }),
      projection.slots[1]!,
    ]),
  });
}

function coordinatorResult(
  run: string,
  stateFingerprint: string,
  disposition: SequenceCoordinatorResult["disposition"],
  artifactAuthority: SequenceCoordinatorResult["artifactAuthority"] = null,
  terminalFingerprint: string | null = null,
): SequenceCoordinatorResult {
  return {
    schema: "h3.context.generation_coordinator.response.v1",
    runHandle: run,
    disposition,
    artifactAuthority,
    terminalFingerprint,
    sequence: { state_fingerprint: stateFingerprint },
    production: {},
  } as unknown as SequenceCoordinatorResult;
}

function preflight(
  ownedProjectionFingerprint: string,
): ManagedAppModePreflight {
  return {
    bootstrap: { output: {}, workflow: {} },
    observation: {
      schema: "h3.context.prepared_graph_observation.v4",
      route: "existing",
      graph_fingerprint: fingerprint("5"),
      compiled_prompt_fingerprint: fingerprint("6"),
      owned_projection_fingerprint: ownedProjectionFingerprint,
      owned_node_ids: ["1"],
      owned_link_ids: [],
      model_fingerprint: fingerprint("7"),
      runtime_fingerprint: fingerprint("8"),
      fingerprint_domain: "output_producing_graph",
      expected_frames: 192,
      source_identity: null,
      timeout_ms: 60_000,
      native_anchor_node_id: "native.1",
    },
    productShellNodeId: "product.shell.1",
    nativeAnchorNodeId: "native.1",
  };
}

const startIntent = Object.freeze({
  authorization: {
    workspace_handle: `pw_${"w".repeat(40)}`,
    expected_workspace_revision: 1,
    expected_workspace_fingerprint: fingerprint("a"),
    expected_plan_fingerprint: fingerprint("b"),
    generation_plan_fingerprint: fingerprint("c"),
    compiler_fingerprint: fingerprint("d"),
    host_capability_fingerprint: fingerprint("e"),
    explicit_intent: "generate_approved_sequence" as const,
  },
  qualificationFingerprint: fingerprint("f"),
  segmentIds: ["segment.1", "segment.2"],
});

describe("managed parent client", () => {
  it("decodes the exact child coordinator authority only on a bound result", () => {
    const wire = {
      ...mutationWire(),
      child_authority: {
        schema: "h3.context.managed_sequence_child_authority.v1",
        run_handle: "mc_" + "d".repeat(40),
        state_fingerprint: fingerprint("4"),
        job_id: "job.segment.1",
        transaction_id: "transaction.segment.1",
      },
    };

    expect(decodeManagedSequenceMutationResult(wire).childAuthority).toEqual({
      schema: "h3.context.managed_sequence_child_authority.v1",
      runHandle: "mc_" + "d".repeat(40),
      stateFingerprint: fingerprint("4"),
      jobId: "job.segment.1",
      transactionId: "transaction.segment.1",
    });
  });

  it("sends one closed mutation action through the dedicated route", async () => {
    const fetchApi = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => mutationWire(),
    }));
    const client = createManagedSequenceClient({ fetchApi });

    await expect(
      client.send("start.sequence.1", "start_sequence", {
        parent_sequence_id: parentSequenceId,
        expected_revision: 0,
        authorization_fingerprint: fingerprint("1"),
      }),
    ).resolves.toMatchObject({
      parentSequenceId,
      state: "active",
      revision: 1,
      parentExpiresAtEpochMs: 87_400_000,
    });
    const firstCall = fetchApi.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(firstCall[1].body as string);
    expect(body).toEqual({
      schema: MANAGED_SEQUENCE_ACTION_SCHEMA,
      request_id: "start.sequence.1",
      action: "start_sequence",
      payload: {
        parent_sequence_id: parentSequenceId,
        expected_revision: 0,
        authorization_fingerprint: fingerprint("1"),
      },
    });
  });

  it("reads current progress without a request id and honors ETag 304", async () => {
    const fetchApi = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === "etag" ? fingerprint("3") : null),
        },
        json: async () => projectionWire(),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 304,
        headers: {
          get: (name: string) => (name === "etag" ? fingerprint("3") : null),
        },
        json: vi.fn(),
      });
    const client = createManagedSequenceClient({ fetchApi });

    const current = await client.read(parentSequenceId, fingerprint("2"));
    const unchanged = await client.read(
      parentSequenceId,
      fingerprint("2"),
      current.etag,
    );

    expect(current).toMatchObject({ status: 200, etag: fingerprint("3") });
    expect(current.projection?.lease.idleExpiryHandled).toBe(false);
    expect(unchanged).toEqual({
      status: 304,
      etag: fingerprint("3"),
      projection: null,
    });
    expect(fetchApi.mock.calls[0][0]).toContain(
      encodeURIComponent(parentSequenceId),
    );
    expect(fetchApi.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(fetchApi.mock.calls[0][1]).not.toHaveProperty("body");
    expect(fetchApi.mock.calls[1][1].headers).toMatchObject({
      "if-none-match": fingerprint("3"),
    });
  });

  it("rejects a projection whose ordered slots or active child are contradictory", () => {
    const wrongOrdinal = projectionWire();
    wrongOrdinal.slots[0]!.ordinal = 2;
    expect(() => decodeManagedSequenceProjection(wrongOrdinal)).toThrow(
      "invalid_response",
    );

    expect(() =>
      decodeManagedSequenceProjection({
        ...projectionWire(),
        active_segment_id: "segment.foreign",
      }),
    ).toThrow("invalid_response");
  });
});

describe("one bounded managed-sequence reattach pointer", () => {
  it("keeps browser persistence behind the host adapter and preserves foreign keys", () => {
    const foreignKey = "host.foreign.preference";
    globalThis.localStorage.removeItem(MANAGED_SEQUENCE_REATTACH_STORAGE_KEY);
    globalThis.localStorage.setItem(foreignKey, "preserve");

    try {
      const store = createBrowserManagedSequenceReattachStore(() => 1_000);
      expect(
        store.replace({
          parentSequenceId,
          readAuthorityFingerprint: fingerprint("2"),
          expiresAtEpochMs: 10_000,
        }),
      ).toBe(true);
      expect(store.read()?.parentSequenceId).toBe(parentSequenceId);

      store.clear();
      expect(
        globalThis.localStorage.getItem(MANAGED_SEQUENCE_REATTACH_STORAGE_KEY),
      ).toBeNull();
      expect(globalThis.localStorage.getItem(foreignKey)).toBe("preserve");
    } finally {
      globalThis.localStorage.removeItem(MANAGED_SEQUENCE_REATTACH_STORAGE_KEY);
      globalThis.localStorage.removeItem(foreignKey);
    }
  });

  it("replaces the only pointer and round-trips no mutation authority", () => {
    const storage = memoryStorage();
    const store = createManagedSequenceReattachStore(storage, () => 1_000);

    store.replace({
      parentSequenceId,
      readAuthorityFingerprint: fingerprint("2"),
      expiresAtEpochMs: 10_000,
    });
    store.replace({
      parentSequenceId: "managed.sequence.2",
      readAuthorityFingerprint: fingerprint("4"),
      expiresAtEpochMs: 20_000,
    });

    expect(storage.length).toBe(1);
    expect(store.read()).toEqual({
      schema: "h3.context.managed_sequence_reattach_pointer.v1",
      parentSequenceId: "managed.sequence.2",
      readAuthorityFingerprint: fingerprint("4"),
      expiresAtEpochMs: 20_000,
    });
    const serialized =
      storage.getItem(MANAGED_SEQUENCE_REATTACH_STORAGE_KEY) ?? "";
    expect(serialized).not.toMatch(/request|resume|cancel|retry|queue|prompt/i);
  });

  it("removes corrupt or expired pointers without guessing a backend parent", () => {
    const storage = memoryStorage();
    const store = createManagedSequenceReattachStore(storage, () => 10_000);
    storage.setItem(MANAGED_SEQUENCE_REATTACH_STORAGE_KEY, "{not-json");
    expect(store.read()).toBeUndefined();
    expect(storage.length).toBe(0);

    expect(
      store.replace({
        parentSequenceId,
        readAuthorityFingerprint: fingerprint("2"),
        expiresAtEpochMs: 9_999,
      }),
    ).toBe(false);
    expect(store.read()).toBeUndefined();
    expect(storage.length).toBe(0);
  });

  it("stores the pointer synchronously before a first queue effect can run", async () => {
    const storage = memoryStorage();
    const store = createManagedSequenceReattachStore(storage, () => 1_000);
    const events: string[] = [];

    store.replace({
      parentSequenceId,
      readAuthorityFingerprint: fingerprint("2"),
      expiresAtEpochMs: 10_000,
    });
    await Promise.resolve().then(() => {
      expect(store.read()).toBeDefined();
      events.push("queue");
    });

    expect(events).toEqual(["queue"]);
  });
});

describe("managed serial sequence runner", () => {
  it.each(
    ["resolve", "compile"].flatMap((phase) => [
      {
        phase,
        error: new SequenceMediaBindingError("sequence_media_changed"),
        code: "sequence_media_changed",
      },
      {
        phase,
        error: new SequenceMediaBindingError("sequence_media_unavailable"),
        code: "sequence_media_unavailable",
      },
      {
        phase,
        error: new AppModeError(
          "sequence_media_changed",
          "bounded media refusal",
        ),
        code: "sequence_media_changed",
      },
      { phase, error: new Error("sequence_media_changed"), code: undefined },
    ]),
  )(
    "preserves only typed pre-bind media reasons at $phase: $code",
    async ({ phase, error, code }) => {
      const calls: { action: string; payload: Record<string, unknown> }[] = [];
      const frameResult = (
        revision: number,
        state: Parameters<typeof mutationResult>[1],
        executionValue: EligibleSegmentExecution | null = null,
        failureCode: string | null = null,
      ) => ({
        ...mutationResult(revision, state, executionValue),
        schema: "h3.context.managed_sequence_result.v2" as const,
        sequenceTaskMode: "i2va" as const,
        failureCode: failureCode as
          "sequence_media_changed" | "sequence_media_unavailable" | null,
      });
      const parentClient = {
        send: vi.fn(
          async (
            _id: string,
            action: string,
            payload: Record<string, unknown>,
          ) => {
            calls.push({ action, payload });
            if (action === "authorize_sequence")
              return frameResult(0, "authorized");
            if (action === "start_sequence") return frameResult(1, "active");
            if (action === "prepare_sequence_child")
              return frameResult(2, "active", execution("segment.1", 2));
            if (action === "fail_prepared_child")
              return frameResult(
                3,
                "paused_failure",
                null,
                (payload.failure_code as string) ?? null,
              );
            throw new Error(`unexpected ${action}`);
          },
        ),
        read: vi.fn(),
      };
      const coordinatorClient = { send: vi.fn() };
      const runner = createManagedSerialSequenceRunner({
        parentClient,
        coordinatorClient,
        reattachStore: createManagedSequenceReattachStore(
          memoryStorage(),
          () => 1_000,
        ),
        resolveChild: async () => {
          if (phase === "resolve") throw error;
          return {
            inputs: {
              task_mode: "i2va",
              first_frame_source: "9",
              user_intent: "synthetic",
              duration_milliseconds: 8_000,
              frame_count: 192,
            },
            workflowAuthority: {},
            activeWorkflowFingerprint: fingerprint("9"),
            previousOwnedProjectionFingerprint: fingerprint("0"),
          };
        },
        startChild: async () => {
          throw error;
        },
      });
      await expect(
        runner.start({ ...startIntent, sequenceTaskMode: "i2va" }),
      ).rejects.toThrow();
      const failed = calls.find(
        (call) => call.action === "fail_prepared_child",
      )!;
      expect(failed.payload.failure_code).toBe(code);
      expect(Object.hasOwn(failed.payload, "failure_code")).toBe(
        code !== undefined,
      );
      expect(calls.some((call) => call.action === "bind_prepared_child")).toBe(
        false,
      );
      expect(coordinatorClient.send).not.toHaveBeenCalled();
      expect(runner.snapshot()).toMatchObject({
        parentState: "paused_failure",
        activeSegmentId: null,
      });
    },
  );

  it.each(["success", "refused"])(
    "refuses a duplicate captured while Start is in flight before eventual %s",
    async (outcome) => {
      const gate = deferred<ManagedSequenceMutationResult>();
      const actions: string[] = [];
      const parentClient = {
        send: vi.fn(async (_id: string, action: string) => {
          actions.push(action);
          if (action === "authorize_sequence")
            return mutationResult(0, "authorized");
          if (action === "start_sequence") return gate.promise;
          if (action === "record_reuse") return mutationResult(2, "succeeded");
          throw new Error(`unexpected ${action}`);
        }),
        read: vi.fn(),
      };
      const runner = createManagedSerialSequenceRunner({
        parentClient,
        coordinatorClient: { send: vi.fn() },
        reattachStore: createManagedSequenceReattachStore(
          memoryStorage(),
          () => 1_000,
        ),
        startChild: vi.fn(),
        resolveChild: vi.fn(),
        resolveReuse: async () => ({
          artifactReceiptFingerprint: fingerprint("5"),
          byteLength: 1,
          terminalFingerprint: fingerprint("6"),
        }),
      });
      const intent = { ...startIntent, segmentIds: ["segment.1"] };
      const first = runner.start(intent);
      const firstExpectation =
        outcome === "success"
          ? expect(first).resolves.toBeUndefined()
          : expect(first).rejects.toThrow("sequence_media_unavailable");
      await vi.waitFor(() =>
        expect(actions).toEqual(["authorize_sequence", "start_sequence"]),
      );
      let duplicateSettled = false;
      const duplicate = expect(
        runner.start(intent).finally(() => {
          duplicateSettled = true;
        }),
      ).rejects.toThrow("already_started");
      // The duplicate refusal must wait on the in-flight transport, even when its caller attaches
      // a rejection handler later. Assert that ordering directly instead of relying on runner errors.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(duplicateSettled).toBe(false);
      if (outcome === "success") gate.resolve(mutationResult(1, "active"));
      else {
        // Rejection originates in a real asynchronous transport, after the duplicate was captured.
        gate.reject(new Error("sequence_media_unavailable"));
      }
      await firstExpectation;
      await duplicate;
      expect(
        actions.filter((action) => action === "authorize_sequence"),
      ).toHaveLength(1);
      expect(
        actions.filter((action) => action === "start_sequence"),
      ).toHaveLength(1);
    },
  );

  it("retains authorization after a refused concrete Start and retries the same plan", async () => {
    const starts: Record<string, unknown>[] = [];
    const parentClient = {
      send: vi.fn(
        async (
          _id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          if (action === "authorize_sequence")
            return mutationResult(0, "authorized");
          if (action === "start_sequence") {
            starts.push(payload);
            if (starts.length === 1)
              throw new Error("sequence_media_unavailable");
            return mutationResult(1, "active");
          }
          if (action === "record_reuse") return mutationResult(2, "succeeded");
          throw new Error(`unexpected ${action}`);
        },
      ),
      read: vi.fn(),
    };
    const startChild = vi.fn();
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient: { send: vi.fn() },
      reattachStore: createManagedSequenceReattachStore(
        memoryStorage(),
        () => 1_000,
      ),
      startChild,
      resolveChild: vi.fn(),
      resolveReuse: async () => ({
        artifactReceiptFingerprint: fingerprint("5"),
        byteLength: 1,
        terminalFingerprint: fingerprint("6"),
      }),
    });
    const intent = { ...startIntent, segmentIds: ["segment.1"] };
    await expect(runner.start(intent)).rejects.toThrow(
      "sequence_media_unavailable",
    );
    expect(startChild).not.toHaveBeenCalled();
    await runner.start(intent);
    expect(
      parentClient.send.mock.calls.filter(
        ([, action]) => action === "authorize_sequence",
      ),
    ).toHaveLength(1);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toEqual(starts[0]);
    expect(runner.snapshot().parentState).toBe("succeeded");
  });

  it.each(["sequence_media_changed", "sequence_media_unavailable"] as const)(
    "adopts a claim-time %s pause before refusing the queue",
    async (failureCode) => {
      const frameResult = (
        revision: number,
        state: Parameters<typeof mutationResult>[1],
        executionValue: EligibleSegmentExecution | null = null,
      ) => ({
        ...mutationResult(revision, state, executionValue),
        schema: "h3.context.managed_sequence_result.v2" as const,
        sequenceTaskMode: "i2va" as const,
        failureCode: state === "paused_failure" ? failureCode : null,
      });
      const parentClient = {
        send: vi.fn(async (_id: string, action: string) => {
          if (action === "authorize_sequence")
            return frameResult(0, "authorized");
          if (action === "start_sequence") return frameResult(1, "active");
          if (action === "prepare_sequence_child")
            return frameResult(2, "active", execution("segment.1", 2));
          if (action === "bind_prepared_child")
            return frameResult(3, "paused_failure");
          throw new Error(`unexpected ${action}`);
        }),
        read: vi.fn(),
      };
      let queues = 0;
      const runner = createManagedSerialSequenceRunner({
        parentClient,
        coordinatorClient: { send: vi.fn() },
        reattachStore: createManagedSequenceReattachStore(
          memoryStorage(),
          () => 1_000,
        ),
        startChild: async (_inputs, options = {}) => {
          await options.prepareManaged!(preflight(fingerprint("9")));
          queues++;
          throw new Error("must not queue");
        },
        resolveChild: async () => ({
          inputs: {
            task_mode: "i2va",
            user_intent: "synthetic",
            duration_milliseconds: 8_000,
            frame_count: 192,
          },
          workflowAuthority: {},
          activeWorkflowFingerprint: fingerprint("9"),
          previousOwnedProjectionFingerprint: fingerprint("0"),
        }),
      });
      await expect(
        runner.start({ ...startIntent, sequenceTaskMode: "i2va" }),
      ).rejects.toThrow(failureCode);
      expect(queues).toBe(0);
      expect(runner.snapshot()).toMatchObject({
        parentState: "paused_failure",
        activeSegmentId: null,
      });
    },
  );

  it.each(["running-first", "artifact-first", "terminal-first"] as const)(
    "keeps monotonic child progress for %s observations and releases before its successor",
    async (order) => {
      const events: string[] = [];
      const storage = memoryStorage();
      const reattachStore = createManagedSequenceReattachStore(
        storage,
        () => 1_000,
      );
      let revision = -1;
      let activeSegment = "segment.1";
      let childNumber = 0;
      let childState = fingerprint("1");
      const artifactSeen = new Set<number>();
      const terminalSeen = new Set<number>();
      let parentChildState = "prepared";
      const parentClient = {
        send: vi.fn(
          async (
            _requestId: string,
            action: string,
            payload: Record<string, unknown>,
          ) => {
            events.push(`parent:${action}`);
            if (action === "authorize_sequence") {
              revision = 0;
              return mutationResult(revision, "authorized");
            }
            expect(payload.expected_revision).toBe(revision);
            if (action === "start_sequence") {
              revision = 1;
              return mutationResult(revision, "active");
            }
            if (action === "prepare_sequence_child") {
              parentChildState = "prepared";
              activeSegment = payload.segment_id as string;
              revision += 1;
              return mutationResult(
                revision,
                "active",
                execution(
                  activeSegment,
                  revision,
                  payload.predecessor_terminal_fingerprint as string | null,
                ),
              );
            }
            if (action === "bind_prepared_child") {
              childNumber += 1;
              revision += 1;
              childState = fingerprint(String(childNumber + 1));
              return mutationResult(revision, "active", null, {
                schema: "h3.context.managed_sequence_child_authority.v1",
                runHandle: `mc_${String(childNumber).repeat(40)}`,
                stateFingerprint: childState,
                jobId: `job.${childNumber}`,
                transactionId: `transaction.${childNumber}`,
              });
            }
            if (action === "record_submission") {
              parentChildState = "submitted";
              revision += 2;
              return mutationResult(revision, "active");
            }
            if (action === "record_running") {
              // Match the real parent FSM: output authority may advance straight from submitted.
              if (
                parentChildState !== "submitted" &&
                parentChildState !== "running"
              )
                throw new Error("invalid_child_transition");
              parentChildState = "running";
              revision += 1;
              return mutationResult(revision, "active");
            }
            if (action === "record_artifact") {
              expect(["submitted", "running"]).toContain(parentChildState);
              parentChildState = "artifact_verified";
              revision += 1;
              return mutationResult(revision, "active");
            }
            if (action === "record_terminal") {
              expect(parentChildState).toBe("artifact_verified");
              parentChildState = "succeeded";
              revision += 1;
              return mutationResult(
                revision,
                activeSegment === "segment.2" ? "succeeded" : "active",
              );
            }
            throw new Error(`unexpected parent action ${action}`);
          },
        ),
        read: vi.fn(),
      };
      const coordinatorClient = {
        send: vi.fn(
          async (
            _requestId: string,
            action: string,
            payload: Record<string, unknown>,
          ) => {
            events.push(`child:${action}`);
            const run = payload.run_handle as string;
            if (action === "record_submission") {
              childState = fingerprint(String(childNumber + 3));
              return coordinatorResult(run, childState, "submitted");
            }
            if (action === "record_running") {
              if (terminalSeen.has(childNumber))
                throw new Error("invalid_generation_transition");
              childState = fingerprint(String(childNumber + 4));
              return coordinatorResult(run, childState, "running");
            }
            if (action === "record_artifact") {
              artifactSeen.add(childNumber);
              childState = fingerprint(String(childNumber + 5));
              return coordinatorResult(
                run,
                childState,
                terminalSeen.has(childNumber)
                  ? "succeeded"
                  : "artifact_verified",
                {
                  schema:
                    "h3.context.generation_coordinator.artifact_authority.v1",
                  receiptFingerprint: fingerprint("a"),
                  byteLength: 23,
                },
                terminalSeen.has(childNumber) ? fingerprint("b") : null,
              );
            }
            if (action === "record_terminal") {
              terminalSeen.add(childNumber);
              childState = fingerprint(String(childNumber + 7));
              return coordinatorResult(
                run,
                childState,
                artifactSeen.has(childNumber)
                  ? "succeeded"
                  : "verification_pending",
                artifactSeen.has(childNumber)
                  ? {
                      schema:
                        "h3.context.generation_coordinator.artifact_authority.v1",
                      receiptFingerprint: fingerprint("a"),
                      byteLength: 23,
                    }
                  : null,
                artifactSeen.has(childNumber) ? fingerprint("b") : null,
              );
            }
            if (action === "release_sequence")
              return coordinatorResult(run, childState, "released");
            throw new Error(`unexpected coordinator action ${action}`);
          },
        ),
      };
      const workflowAuthority = {};
      let queueCalls = 0;
      const startChild = vi.fn(
        async (
          _inputs: AppModeInputs,
          options: AppModeStartOptions = {},
        ): Promise<AppModeStartResult> => {
          const owned = fingerprint(String(childNumber + 8));
          const prepared = preflight(owned);
          const authority = await options.prepareManaged!(prepared);
          authority.bindCanvasIdentity?.({
            workflowAuthority,
            ownedReference: {
              nodeIds: ["1"],
              linkIds: [],
              anchorNodeId: "1",
              authoredWidgetNodeIds: [],
            },
          });
          queueCalls += 1;
          events.push(`queue:${activeSegment}`);
          authority.onQueueSubmitted();
          const result: AppModeStartResult = {
            queueResult: {
              prompt_id: `prompt.${childNumber}`,
              number: childNumber,
              nodeErrorClassTypes: Object.freeze([]),
              nodeErrorTypes: Object.freeze([]),
            },
            graphFingerprint: prepared.observation.graph_fingerprint,
            compiledPromptFingerprint:
              prepared.observation.compiled_prompt_fingerprint,
            ownedProjectionFingerprint: owned,
            ownedNodeIds: ["1"],
            ownedLinkIds: [],
            queuePromptId: `prompt.${childNumber}`,
            route: "existing",
          };
          await authority.onQueueAccepted(result);
          return result;
        },
      );
      const runner = createManagedSerialSequenceRunner({
        parentClient,
        coordinatorClient,
        reattachStore,
        startChild,
        resolveChild: async (_eligible, _context, index) => ({
          inputs: {
            task_mode: "t2va",
            user_intent: "synthetic",
            duration_milliseconds: 8_000,
            frame_count: 192,
          },
          options: { useExisting: true },
          workflowAuthority,
          activeWorkflowFingerprint: fingerprint("9"),
          previousOwnedProjectionFingerprint:
            index === 0 ? fingerprint("0") : fingerprint("9"),
        }),
      });

      expect(queueCalls).toBe(0);
      expect(runner.canvasLabel()).toBeNull();
      await runner.start(startIntent);
      expect(queueCalls).toBe(1);
      expect(reattachStore.read()?.parentSequenceId).toBe(parentSequenceId);
      // The bound label is the one an explicit resume or retry must present again.
      expect(runner.canvasLabel()).toEqual({
        workflowAuthority,
        activeWorkflowFingerprint: fingerprint("9"),
      });
      expect(runner.canvasLabel()?.workflowAuthority).toBe(workflowAuthority);

      await runner.recordRunning("prompt.foreign");
      await runner.recordArtifact({
        promptId: "prompt.foreign",
        outputNodeId: "save.video",
        locator: { filename: "foreign.mp4", subfolder: "", type: "output" },
      });
      await runner.recordTerminal({
        promptId: "prompt.foreign",
        kind: "success",
      });
      const artifact = () =>
        runner.recordArtifact({
          promptId: "prompt.1",
          outputNodeId: "save.video",
          locator: { filename: "managed.mp4", subfolder: "", type: "output" },
        });
      const terminal = () =>
        runner.recordTerminal({ promptId: "prompt.1", kind: "success" });
      const first =
        order === "artifact-first"
          ? artifact()
          : order === "terminal-first"
            ? terminal()
            : runner.recordRunning("prompt.1");
      // Queue observations while the earlier asynchronous publication is still pending.
      const lateRunning = runner.recordRunning("prompt.1");
      const repeatedRunning = runner.recordRunning("prompt.1");
      await Promise.all([first, lateRunning, repeatedRunning]);
      expect(
        coordinatorClient.send.mock.calls.filter(
          ([, action]) => action === "record_running",
        ),
      ).toHaveLength(order === "running-first" ? 1 : 0);
      expect(
        parentClient.send.mock.calls.filter(
          ([, action]) => action === "record_running",
        ),
      ).toHaveLength(order === "running-first" ? 1 : 0);

      expect(queueCalls).toBe(1);
      if (order !== "artifact-first") await artifact();
      if (order !== "terminal-first") await terminal();

      expect(queueCalls).toBe(2);
      expect(events.indexOf("child:release_sequence")).toBeLessThan(
        events.indexOf("parent:record_terminal"),
      );
      expect(events.indexOf("parent:record_terminal")).toBeLessThan(
        events.indexOf("queue:segment.2"),
      );

      const beforeStaleRunning = events.length;
      await runner.recordRunning("prompt.1");
      expect(events).toHaveLength(beforeStaleRunning);
      await runner.recordRunning("prompt.2");
      await runner.recordRunning("prompt.2");
      expect(events.slice(beforeStaleRunning)).toEqual([
        "child:record_running",
        "parent:record_running",
      ]);
      await runner.recordTerminal({ promptId: "prompt.2", kind: "success" });
      expect(queueCalls).toBe(2);
      await runner.recordArtifact({
        promptId: "prompt.2",
        outputNodeId: "save.video",
        locator: { filename: "managed-2.mp4", subfolder: "", type: "output" },
      });
      expect(queueCalls).toBe(2);
      expect(runner.snapshot()).toMatchObject({
        attached: true,
        parentState: "succeeded",
        activeSegmentId: null,
      });
    },
  );

  it("records an ambiguous invocation once and never schedules another child", async () => {
    let revision = -1;
    let queueCalls = 0;
    const actions: string[] = [];
    const parentClient = {
      send: vi.fn(async (_id: string, action: string) => {
        actions.push(action);
        if (action === "authorize_sequence") {
          revision = 0;
          return mutationResult(revision, "authorized");
        }
        if (action === "start_sequence") {
          revision = 1;
          return mutationResult(revision, "active");
        }
        if (action === "prepare_sequence_child") {
          revision = 2;
          return mutationResult(
            revision,
            "active",
            execution("segment.1", revision),
          );
        }
        if (action === "bind_prepared_child") {
          revision = 3;
          return mutationResult(revision, "active", null, {
            schema: "h3.context.managed_sequence_child_authority.v1",
            runHandle: `mc_${"1".repeat(40)}`,
            stateFingerprint: fingerprint("4"),
            jobId: "job.1",
            transactionId: "transaction.1",
          });
        }
        if (action === "mark_invocation_unknown") {
          revision = 5;
          return mutationResult(revision, "paused_unknown_ownership");
        }
        throw new Error(`unexpected action ${action}`);
      }),
      read: vi.fn(),
    };
    const workflowAuthority = {};
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient: { send: vi.fn() },
      reattachStore: createManagedSequenceReattachStore(
        memoryStorage(),
        () => 1_000,
      ),
      startChild: async (_inputs, options = {}) => {
        const prepared = preflight(fingerprint("9"));
        const authority = await options.prepareManaged!(prepared);
        authority.bindCanvasIdentity?.({
          workflowAuthority,
          ownedReference: {
            nodeIds: ["1"],
            linkIds: [],
            anchorNodeId: "1",
            authoredWidgetNodeIds: [],
          },
        });
        queueCalls += 1;
        authority.onQueueSubmitted();
        await authority.onQueueFailed("ambiguous");
        throw new Error("ambiguous queue acknowledgement");
      },
      resolveChild: async () => ({
        inputs: {
          task_mode: "t2va",
          user_intent: "synthetic",
          duration_milliseconds: 8_000,
          frame_count: 192,
        },
        workflowAuthority,
        activeWorkflowFingerprint: fingerprint("8"),
        previousOwnedProjectionFingerprint: fingerprint("7"),
      }),
    });

    await expect(runner.start(startIntent)).rejects.toThrow(
      "ambiguous queue acknowledgement",
    );
    expect(queueCalls).toBe(1);
    expect(
      actions.filter((action) => action === "mark_invocation_unknown"),
    ).toHaveLength(1);
    expect(actions).not.toContain("record_submission");
    expect(runner.snapshot()).toMatchObject({
      parentState: "paused_unknown_ownership",
      activeSegmentId: "segment.1",
    });
  });

  it("records exact reuse before child preparation and queues only the dirty successor", async () => {
    let revision = -1;
    const actions: string[] = [];
    const workflowAuthority = {};
    const parentClient = {
      send: vi.fn(
        async (
          _id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          actions.push(action);
          if (action === "authorize_sequence") {
            revision = 0;
            return mutationResult(revision, "authorized");
          }
          if (action === "start_sequence") {
            revision = 1;
            return mutationResult(revision, "active");
          }
          if (action === "record_reuse") {
            expect(payload).toMatchObject({
              segment_id: "segment.1",
              artifact_receipt_fingerprint: fingerprint("a"),
              artifact_bytes: 23,
              terminal_fingerprint: fingerprint("b"),
            });
            revision = 2;
            return mutationResult(revision, "active");
          }
          if (action === "prepare_sequence_child") {
            expect(payload).toMatchObject({
              segment_id: "segment.2",
              predecessor_terminal_fingerprint: fingerprint("b"),
            });
            revision = 3;
            return mutationResult(
              revision,
              "active",
              execution("segment.2", revision, fingerprint("b")),
            );
          }
          if (action === "bind_prepared_child") {
            revision = 4;
            return mutationResult(revision, "active", null, {
              schema: "h3.context.managed_sequence_child_authority.v1",
              runHandle: `mc_${"2".repeat(40)}`,
              stateFingerprint: fingerprint("c"),
              jobId: "job.2",
              transactionId: "transaction.2",
            });
          }
          if (action === "record_submission") {
            revision = 6;
            return mutationResult(revision, "active");
          }
          throw new Error(`unexpected parent action ${action}`);
        },
      ),
      read: vi.fn(),
    };
    const coordinatorClient = {
      send: vi.fn(
        async (
          _id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          if (action === "record_submission")
            return coordinatorResult(
              payload.run_handle as string,
              fingerprint("d"),
              "submitted",
            );
          throw new Error(`unexpected coordinator action ${action}`);
        },
      ),
    };
    let queueCalls = 0;
    const startChild = vi.fn(
      async (
        _inputs: AppModeInputs,
        options: AppModeStartOptions = {},
      ): Promise<AppModeStartResult> => {
        const prepared = preflight(fingerprint("0"));
        const queueAuthority = await options.prepareManaged!(prepared);
        queueAuthority.bindCanvasIdentity?.({
          workflowAuthority,
          ownedReference: {
            nodeIds: ["1"],
            linkIds: [],
            anchorNodeId: "1",
            authoredWidgetNodeIds: [],
          },
        });
        queueCalls += 1;
        queueAuthority.onQueueSubmitted();
        const result: AppModeStartResult = {
          queueResult: {
            prompt_id: "prompt.2",
            number: 2,
            nodeErrorClassTypes: Object.freeze([]),
            nodeErrorTypes: Object.freeze([]),
          },
          graphFingerprint: prepared.observation.graph_fingerprint,
          compiledPromptFingerprint:
            prepared.observation.compiled_prompt_fingerprint,
          ownedProjectionFingerprint: fingerprint("0"),
          ownedNodeIds: ["1"],
          ownedLinkIds: [],
          queuePromptId: "prompt.2",
          route: "existing",
        };
        await queueAuthority.onQueueAccepted(result);
        return result;
      },
    );
    const resolveChild = vi.fn(async () => ({
      inputs: {
        task_mode: "t2va" as const,
        user_intent: "synthetic",
        duration_milliseconds: 8_000,
        frame_count: 192,
      },
      workflowAuthority,
      activeWorkflowFingerprint: fingerprint("8"),
      previousOwnedProjectionFingerprint: fingerprint("7"),
    }));
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient,
      reattachStore: createManagedSequenceReattachStore(
        memoryStorage(),
        () => 1_000,
      ),
      startChild,
      resolveChild,
      resolveReuse: vi.fn(async (_segmentId, index) =>
        index === 0
          ? {
              artifactReceiptFingerprint: fingerprint("a"),
              byteLength: 23,
              terminalFingerprint: fingerprint("b"),
            }
          : null,
      ),
    });

    await runner.start(startIntent);

    expect(actions.indexOf("record_reuse")).toBeLessThan(
      actions.indexOf("prepare_sequence_child"),
    );
    expect(queueCalls).toBe(1);
    expect(resolveChild).toHaveBeenCalledTimes(1);
  });

  it("cancels successor effects while allowing the already host-owned child to terminalize", async () => {
    let revision = -1;
    let queueCalls = 0;
    const actions: string[] = [];
    const workflowAuthority = {};
    const parentClient = {
      send: vi.fn(
        async (
          _id: string,
          action: string,
          _payload: Record<string, unknown>,
        ) => {
          actions.push(action);
          if (action === "authorize_sequence") {
            revision = 0;
            return mutationResult(revision, "authorized");
          }
          if (action === "start_sequence") {
            revision = 1;
            return mutationResult(revision, "active");
          }
          if (action === "prepare_sequence_child") {
            revision = 2;
            return mutationResult(
              revision,
              "active",
              execution("segment.1", revision),
            );
          }
          if (action === "bind_prepared_child") {
            revision = 3;
            return mutationResult(revision, "active", null, {
              schema: "h3.context.managed_sequence_child_authority.v1",
              runHandle: `mc_${"1".repeat(40)}`,
              stateFingerprint: fingerprint("4"),
              jobId: "job.1",
              transactionId: "transaction.1",
            });
          }
          if (action === "record_submission") {
            revision = 5;
            return mutationResult(revision, "active");
          }
          if (action === "cancel_sequence") {
            revision = 6;
            return mutationResult(revision, "cancelled");
          }
          if (action === "record_terminal") {
            revision = 7;
            return mutationResult(revision, "cancelled");
          }
          throw new Error(`unexpected parent action ${action}`);
        },
      ),
      read: vi.fn(),
    };
    const coordinatorClient = {
      send: vi.fn(
        async (
          _id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          const run = payload.run_handle as string;
          if (action === "record_submission")
            return coordinatorResult(run, fingerprint("5"), "submitted");
          if (action === "record_terminal")
            return coordinatorResult(
              run,
              fingerprint("6"),
              "failed",
              null,
              fingerprint("7"),
            );
          if (action === "release_sequence")
            return coordinatorResult(run, fingerprint("6"), "released");
          throw new Error(`unexpected coordinator action ${action}`);
        },
      ),
    };
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient,
      reattachStore: createManagedSequenceReattachStore(
        memoryStorage(),
        () => 1_000,
      ),
      startChild: async (_inputs, options = {}) => {
        const prepared = preflight(fingerprint("9"));
        const queueAuthority = await options.prepareManaged!(prepared);
        queueAuthority.bindCanvasIdentity?.({
          workflowAuthority,
          ownedReference: {
            nodeIds: ["1"],
            linkIds: [],
            anchorNodeId: "1",
            authoredWidgetNodeIds: [],
          },
        });
        queueCalls += 1;
        queueAuthority.onQueueSubmitted();
        const result: AppModeStartResult = {
          queueResult: {
            prompt_id: "prompt.1",
            number: 1,
            nodeErrorClassTypes: Object.freeze([]),
            nodeErrorTypes: Object.freeze([]),
          },
          graphFingerprint: prepared.observation.graph_fingerprint,
          compiledPromptFingerprint:
            prepared.observation.compiled_prompt_fingerprint,
          ownedProjectionFingerprint: fingerprint("9"),
          ownedNodeIds: ["1"],
          ownedLinkIds: [],
          queuePromptId: "prompt.1",
          route: "existing",
        };
        await queueAuthority.onQueueAccepted(result);
        return result;
      },
      resolveChild: async () => ({
        inputs: {
          task_mode: "t2va",
          user_intent: "synthetic",
          duration_milliseconds: 8_000,
          frame_count: 192,
        },
        workflowAuthority,
        activeWorkflowFingerprint: fingerprint("8"),
        previousOwnedProjectionFingerprint: fingerprint("7"),
      }),
    });

    await runner.start(startIntent);
    await runner.cancel();
    await runner.recordTerminal({ promptId: "prompt.1", kind: "error" });

    expect(queueCalls).toBe(1);
    expect(actions).toContain("cancel_sequence");
    expect(
      actions.filter((action) => action === "prepare_sequence_child"),
    ).toHaveLength(1);
    expect(runner.snapshot()).toMatchObject({
      attached: false,
      parentState: "cancelled",
      activeSegmentId: null,
    });
  });

  it("fails a prepared child whose returned predecessor authority drifted before compile or queue", async () => {
    let revision = -1;
    const actions: string[] = [];
    const parentClient = {
      send: vi.fn(async (_id: string, action: string) => {
        actions.push(action);
        if (action === "authorize_sequence") {
          revision = 0;
          return mutationResult(revision, "authorized");
        }
        if (action === "start_sequence") {
          revision = 1;
          return mutationResult(revision, "active");
        }
        if (action === "prepare_sequence_child") {
          revision = 2;
          return mutationResult(revision, "active", {
            ...execution("segment.1", revision),
            predecessorTerminalFingerprint: fingerprint("9"),
          });
        }
        if (action === "fail_prepared_child") {
          revision = 3;
          return mutationResult(revision, "paused_failure");
        }
        throw new Error(`unexpected parent action ${action}`);
      }),
      read: vi.fn(),
    };
    const startChild = vi.fn();
    const resolveChild = vi.fn(async () => ({
      inputs: {
        task_mode: "t2va" as const,
        user_intent: "synthetic",
        duration_milliseconds: 8_000,
        frame_count: 192,
      },
      workflowAuthority: {},
      activeWorkflowFingerprint: fingerprint("8"),
      previousOwnedProjectionFingerprint: fingerprint("7"),
    }));
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient: { send: vi.fn() },
      reattachStore: createManagedSequenceReattachStore(
        memoryStorage(),
        () => 1_000,
      ),
      startChild,
      resolveChild,
    });

    await expect(runner.start(startIntent)).rejects.toMatchObject({
      code: "child_authority_mismatch",
    });
    expect(actions).toContain("fail_prepared_child");
    expect(resolveChild).not.toHaveBeenCalled();
    expect(startChild).not.toHaveBeenCalled();
  });

  it("reattaches read-first to only the exact retained prompt and performs no mutation or queue", async () => {
    const store = createManagedSequenceReattachStore(
      memoryStorage(),
      () => 1_000,
    );
    expect(
      store.replace({
        parentSequenceId,
        readAuthorityFingerprint: fingerprint("2"),
        expiresAtEpochMs: 10_000,
      }),
    ).toBe(true);
    const projection = detachedProjection();
    const events: string[] = [];
    const parentClient = {
      send: vi.fn(),
      read: vi.fn(async (parent: string, readAuthority: string) => {
        events.push("parent-read");
        expect(parent).toBe(parentSequenceId);
        expect(readAuthority).toBe(fingerprint("2"));
        return { status: 200 as const, etag: projection.etag, projection };
      }),
    };
    const historyClient = {
      read: vi.fn(async (promptId: string) => {
        events.push("history-read");
        expect(promptId).toBe("prompt.1");
        return {
          schema: "h3.context.comfy_prompt_history_observation.v1" as const,
          promptId,
          disposition: "not_yet_observed" as const,
          outputNodeIds: Object.freeze([]),
          outputIdentityFingerprint: null,
          terminalFingerprint: null,
        };
      }),
    };
    const startChild = vi.fn();
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient: { send: vi.fn() },
      historyClient,
      reattachStore: store,
      startChild,
      resolveChild: vi.fn(),
    });

    await expect(runner.reattach()).resolves.toMatchObject({
      disposition: "waiting_for_current_child",
      parentState: "paused_client_absent",
      activePromptId: "prompt.1",
    });
    expect(events).toEqual(["parent-read", "history-read"]);
    expect(parentClient.send).not.toHaveBeenCalled();
    expect(startChild).not.toHaveBeenCalled();
  });

  it("keeps a successful exact history row paused when no verified artifact authority was retained", async () => {
    const store = createManagedSequenceReattachStore(
      memoryStorage(),
      () => 1_000,
    );
    store.replace({
      parentSequenceId,
      readAuthorityFingerprint: fingerprint("2"),
      expiresAtEpochMs: 10_000,
    });
    const projection = detachedProjection();
    const parentClient = {
      send: vi.fn(),
      read: vi.fn(async () => ({
        status: 200 as const,
        etag: projection.etag,
        projection,
      })),
    };
    const coordinatorClient = { send: vi.fn() };
    const startChild = vi.fn();
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient,
      historyClient: {
        read: vi.fn(async () => ({
          schema: "h3.context.comfy_prompt_history_observation.v1" as const,
          promptId: "prompt.1",
          disposition: "succeeded" as const,
          outputNodeIds: Object.freeze(["save.video"]),
          outputIdentityFingerprint: fingerprint("e"),
          terminalFingerprint: fingerprint("f"),
        })),
      },
      reattachStore: store,
      startChild,
      resolveChild: vi.fn(),
    });

    await expect(runner.reattach()).resolves.toMatchObject({
      disposition: "artifact_authority_unavailable",
      activePromptId: "prompt.1",
    });
    expect(parentClient.send).not.toHaveBeenCalled();
    expect(coordinatorClient.send).not.toHaveBeenCalled();
    expect(startChild).not.toHaveBeenCalled();
  });

  it("refuses a decoded history observation whose prompt identity differs from the retained path", async () => {
    const store = createManagedSequenceReattachStore(
      memoryStorage(),
      () => 1_000,
    );
    store.replace({
      parentSequenceId,
      readAuthorityFingerprint: fingerprint("2"),
      expiresAtEpochMs: 10_000,
    });
    const projection = detachedProjection("artifact_verified");
    const coordinatorClient = { send: vi.fn() };
    const runner = createManagedSerialSequenceRunner({
      parentClient: {
        send: vi.fn(),
        read: vi.fn(async () => ({
          status: 200 as const,
          etag: projection.etag,
          projection,
        })),
      },
      coordinatorClient,
      historyClient: {
        read: vi.fn(async () => ({
          schema: "h3.context.comfy_prompt_history_observation.v1" as const,
          promptId: "prompt.foreign",
          disposition: "succeeded" as const,
          outputNodeIds: Object.freeze(["save.video"]),
          outputIdentityFingerprint: fingerprint("e"),
          terminalFingerprint: fingerprint("f"),
        })),
      },
      reattachStore: store,
      startChild: vi.fn(),
      resolveChild: vi.fn(),
    });

    await expect(runner.reattach()).resolves.toMatchObject({
      disposition: "artifact_authority_unavailable",
      activePromptId: "prompt.1",
    });
    expect(coordinatorClient.send).not.toHaveBeenCalled();
  });

  it("reconciles a retained artifact plus exact successful history and queues a successor only after explicit resume", async () => {
    const store = createManagedSequenceReattachStore(
      memoryStorage(),
      () => 1_000,
    );
    store.replace({
      parentSequenceId,
      readAuthorityFingerprint: fingerprint("2"),
      expiresAtEpochMs: 10_000,
    });
    const projection = detachedProjection("artifact_verified");
    const events: string[] = [];
    let revision = projection.revision;
    const parentClient = {
      read: vi.fn(async () => {
        events.push("parent:read");
        return { status: 200 as const, etag: projection.etag, projection };
      }),
      send: vi.fn(
        async (
          _requestId: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          events.push(`parent:${action}`);
          expect(payload.expected_revision).toBe(revision);
          if (action === "record_terminal") {
            expect(payload).toMatchObject({
              segment_id: "segment.1",
              queue_prompt_id: "prompt.1",
              kind: "success",
              terminal_fingerprint: fingerprint("b"),
            });
            revision += 1;
            return mutationResult(revision, "paused_client_absent");
          }
          if (action === "resume_sequence") {
            revision += 1;
            return mutationResult(revision, "active");
          }
          if (action === "prepare_sequence_child") {
            expect(payload).toMatchObject({
              segment_id: "segment.2",
              predecessor_terminal_fingerprint: fingerprint("b"),
            });
            revision += 1;
            return mutationResult(
              revision,
              "active",
              execution("segment.2", revision, fingerprint("b")),
            );
          }
          if (action === "bind_prepared_child") {
            revision += 1;
            return mutationResult(revision, "active", null, {
              schema: "h3.context.managed_sequence_child_authority.v1",
              runHandle: `mc_${"2".repeat(40)}`,
              stateFingerprint: fingerprint("c"),
              jobId: "job.2",
              transactionId: "transaction.2",
            });
          }
          if (action === "record_submission") {
            revision += 2;
            return mutationResult(revision, "active");
          }
          throw new Error(`unexpected parent action ${action}`);
        },
      ),
    };
    const coordinatorClient = {
      send: vi.fn(
        async (
          _requestId: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          events.push(`child:${action}`);
          const run = payload.run_handle as string;
          if (action === "record_terminal")
            return coordinatorResult(
              run,
              fingerprint("9"),
              "succeeded",
              {
                schema:
                  "h3.context.generation_coordinator.artifact_authority.v1",
                receiptFingerprint: fingerprint("a"),
                byteLength: 23,
              },
              fingerprint("b"),
            );
          if (action === "release_sequence")
            return coordinatorResult(run, fingerprint("9"), "released");
          if (action === "record_submission")
            return coordinatorResult(run, fingerprint("d"), "submitted");
          throw new Error(`unexpected coordinator action ${action}`);
        },
      ),
    };
    const historyClient = {
      read: vi.fn(async () => ({
        schema: "h3.context.comfy_prompt_history_observation.v1" as const,
        promptId: "prompt.1",
        disposition: "succeeded" as const,
        outputNodeIds: Object.freeze(["save.video"]),
        outputIdentityFingerprint: fingerprint("e"),
        terminalFingerprint: fingerprint("f"),
      })),
    };
    const workflowAuthority = {};
    let queueCalls = 0;
    const startChild = vi.fn(
      async (
        _inputs: AppModeInputs,
        options: AppModeStartOptions = {},
      ): Promise<AppModeStartResult> => {
        const prepared = preflight(fingerprint("0"));
        const queueAuthority = await options.prepareManaged!(prepared);
        queueAuthority.bindCanvasIdentity?.({
          workflowAuthority,
          ownedReference: {
            nodeIds: ["1"],
            linkIds: [],
            anchorNodeId: "1",
            authoredWidgetNodeIds: [],
          },
        });
        queueCalls += 1;
        queueAuthority.onQueueSubmitted();
        const result: AppModeStartResult = {
          queueResult: {
            prompt_id: "prompt.2",
            number: 2,
            nodeErrorClassTypes: Object.freeze([]),
            nodeErrorTypes: Object.freeze([]),
          },
          graphFingerprint: prepared.observation.graph_fingerprint,
          compiledPromptFingerprint:
            prepared.observation.compiled_prompt_fingerprint,
          ownedProjectionFingerprint: fingerprint("0"),
          ownedNodeIds: ["1"],
          ownedLinkIds: [],
          queuePromptId: "prompt.2",
          route: "existing",
        };
        await queueAuthority.onQueueAccepted(result);
        return result;
      },
    );
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient,
      historyClient,
      reattachStore: store,
      startChild,
      resolveChild: async () => ({
        inputs: {
          task_mode: "t2va",
          user_intent: "synthetic",
          duration_milliseconds: 8_000,
          frame_count: 192,
        },
        workflowAuthority,
        activeWorkflowFingerprint: fingerprint("8"),
        previousOwnedProjectionFingerprint: fingerprint("8"),
      }),
    });

    await expect(runner.reattach()).resolves.toMatchObject({
      disposition: "terminal_reconciled",
      parentState: "paused_client_absent",
      activePromptId: null,
    });
    expect(queueCalls).toBe(0);
    expect(events.indexOf("parent:read")).toBeLessThan(
      events.indexOf("child:record_terminal"),
    );
    expect(events.indexOf("child:release_sequence")).toBeLessThan(
      events.indexOf("parent:record_terminal"),
    );
    // A runner that never bound a child in this process has no label to offer: the reattach
    // pointer carries none, so resume after a reload cannot be revalidated from the runner.
    expect(runner.canvasLabel()).toBeNull();

    await runner.resume({
      activeWorkflowFingerprint: fingerprint("8"),
      ownedProjectionFingerprint: fingerprint("8"),
    });
    expect(queueCalls).toBe(1);
    expect(runner.canvasLabel()).toEqual({
      workflowAuthority,
      activeWorkflowFingerprint: fingerprint("8"),
    });
    expect(events.indexOf("parent:resume_sequence")).toBeLessThan(
      events.indexOf("parent:prepare_sequence_child"),
    );
  });

  it("does not restore successor authority when detach wins a pending explicit resume", async () => {
    const store = createManagedSequenceReattachStore(
      memoryStorage(),
      () => 1_000,
    );
    store.replace({
      parentSequenceId,
      readAuthorityFingerprint: fingerprint("2"),
      expiresAtEpochMs: 10_000,
    });
    const retained = detachedProjection();
    const projection: ManagedSequenceProjection = Object.freeze({
      ...retained,
      activeSegmentId: null,
      slots: Object.freeze([
        Object.freeze({
          ...retained.slots[0]!,
          state: "succeeded",
          terminalFingerprint: fingerprint("a"),
        }),
        retained.slots[1]!,
      ]),
    });
    const resumeResult = deferred<ManagedSequenceMutationResult>();
    let revision = projection.revision;
    const parentClient = {
      read: vi.fn(async () => ({
        status: 200 as const,
        etag: projection.etag,
        projection,
      })),
      send: vi.fn(
        async (
          _id: string,
          action: string,
        ): Promise<ManagedSequenceMutationResult> => {
          if (action === "resume_sequence") return resumeResult.promise;
          if (action === "detach_client") {
            revision += 1;
            return mutationResult(revision, "paused_client_absent");
          }
          throw new Error(`unexpected action ${action}`);
        },
      ),
    };
    const startChild = vi.fn();
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient: { send: vi.fn() },
      reattachStore: store,
      startChild,
      resolveChild: vi.fn(),
    });

    await expect(runner.reattach()).resolves.toMatchObject({
      disposition: "resumable",
    });
    const resuming = runner.resume({
      activeWorkflowFingerprint: fingerprint("8"),
      ownedProjectionFingerprint: fingerprint("9"),
    });
    await vi.waitFor(() =>
      expect(parentClient.send).toHaveBeenCalledWith(
        expect.any(String),
        "resume_sequence",
        expect.any(Object),
      ),
    );
    const detaching = runner.detach();
    revision += 1;
    resumeResult.resolve(mutationResult(revision, "active"));

    await expect(resuming).resolves.toBeUndefined();
    await expect(detaching).resolves.toBeUndefined();
    expect(
      parentClient.send.mock.calls.some(
        ([, action]) => action === "prepare_sequence_child",
      ),
    ).toBe(false);
    expect(startChild).not.toHaveBeenCalled();
    expect(runner.snapshot()).toMatchObject({
      attached: false,
      parentState: "paused_client_absent",
    });
  });

  it("reattaches a failed parent and retries the named child only after current canvas proof", async () => {
    const store = createManagedSequenceReattachStore(
      memoryStorage(),
      () => 1_000,
    );
    store.replace({
      parentSequenceId,
      readAuthorityFingerprint: fingerprint("2"),
      expiresAtEpochMs: 10_000,
    });
    const projection = detachedFailureProjection();
    let revision = projection.revision;
    const actions: string[] = [];
    const parentClient = {
      read: vi.fn(async () => ({
        status: 200 as const,
        etag: projection.etag,
        projection,
      })),
      send: vi.fn(
        async (
          _id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          actions.push(action);
          expect(payload.expected_revision).toBe(revision);
          if (action === "retry_segment") {
            expect(payload).toMatchObject({
              segment_id: "segment.1",
              active_workflow_fingerprint: fingerprint("8"),
              owned_projection_fingerprint: fingerprint("9"),
            });
            revision += 1;
            return mutationResult(revision, "active");
          }
          if (action === "prepare_sequence_child") {
            revision += 1;
            return mutationResult(
              revision,
              "active",
              execution("segment.1", revision),
            );
          }
          if (action === "bind_prepared_child") {
            revision += 1;
            return mutationResult(revision, "active", null, {
              schema: "h3.context.managed_sequence_child_authority.v1",
              runHandle: `mc_${"3".repeat(40)}`,
              stateFingerprint: fingerprint("a"),
              jobId: "job.retry.1",
              transactionId: "transaction.retry.1",
            });
          }
          if (action === "record_submission") {
            revision += 2;
            return mutationResult(revision, "active");
          }
          throw new Error(`unexpected parent action ${action}`);
        },
      ),
    };
    const coordinatorClient = {
      send: vi.fn(
        async (
          _id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          if (action === "record_submission")
            return coordinatorResult(
              payload.run_handle as string,
              fingerprint("b"),
              "submitted",
            );
          throw new Error(`unexpected coordinator action ${action}`);
        },
      ),
    };
    const workflowAuthority = {};
    let queueCalls = 0;
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient,
      reattachStore: store,
      startChild: async (_inputs, options = {}) => {
        const prepared = preflight(fingerprint("0"));
        const queueAuthority = await options.prepareManaged!(prepared);
        queueAuthority.bindCanvasIdentity?.({
          workflowAuthority,
          ownedReference: {
            nodeIds: ["1"],
            linkIds: [],
            anchorNodeId: "1",
            authoredWidgetNodeIds: [],
          },
        });
        queueCalls += 1;
        queueAuthority.onQueueSubmitted();
        const result: AppModeStartResult = {
          queueResult: {
            prompt_id: "prompt.retry.1",
            number: 3,
            nodeErrorClassTypes: Object.freeze([]),
            nodeErrorTypes: Object.freeze([]),
          },
          graphFingerprint: prepared.observation.graph_fingerprint,
          compiledPromptFingerprint:
            prepared.observation.compiled_prompt_fingerprint,
          ownedProjectionFingerprint: fingerprint("0"),
          ownedNodeIds: ["1"],
          ownedLinkIds: [],
          queuePromptId: "prompt.retry.1",
          route: "existing",
        };
        await queueAuthority.onQueueAccepted(result);
        return result;
      },
      resolveChild: async () => ({
        inputs: {
          task_mode: "t2va",
          user_intent: "synthetic",
          duration_milliseconds: 8_000,
          frame_count: 192,
        },
        workflowAuthority,
        activeWorkflowFingerprint: fingerprint("8"),
        previousOwnedProjectionFingerprint: fingerprint("9"),
      }),
    });

    await expect(runner.reattach()).resolves.toMatchObject({
      disposition: "current",
      parentState: "paused_failure",
    });
    expect(queueCalls).toBe(0);

    await runner.retry({
      segmentId: "segment.1",
      activeWorkflowFingerprint: fingerprint("8"),
      ownedProjectionFingerprint: fingerprint("9"),
    });
    expect(actions[0]).toBe("retry_segment");
    expect(queueCalls).toBe(1);
  });
});

describe("managed compile failure primacy", () => {
  it.each([
    { bound: false, notificationRejects: false },
    { bound: false, notificationRejects: true },
    { bound: true, notificationRejects: false },
    { bound: true, notificationRejects: true },
  ])(
    "keeps original instance with bound=$bound notificationRejects=$notificationRejects",
    async ({ bound, notificationRejects }) => {
      const original = new AppModeError(
        "compile_failed",
        "synthetic primary compile detail",
        { kind: "template_unavailable" },
        "compiled_admission",
        "requested_route",
      );
      expect(original.compileStep).toBe("compiled_admission");
      expect(original.compileAdmission).toBe("requested_route");
      const notificationAction = bound
        ? "fail_bound_child"
        : "fail_prepared_child";
      const parentClient = {
        read: vi.fn(),
        send: vi.fn(
          async (
            _id: string,
            action: string,
            _payload: Record<string, unknown>,
          ) => {
            if (action === "authorize_sequence")
              return mutationResult(0, "authorized");
            if (action === "start_sequence") return mutationResult(1, "active");
            if (action === "prepare_sequence_child")
              return mutationResult(2, "active", execution("segment.1", 2));
            if (action === "bind_prepared_child")
              return mutationResult(3, "active", null, {
                schema: "h3.context.managed_sequence_child_authority.v1",
                runHandle: `mc_${"d".repeat(40)}`,
                stateFingerprint: fingerprint("4"),
                jobId: "job.segment.1",
                transactionId: "transaction.segment.1",
              });
            if (action === notificationAction) {
              if (notificationRejects)
                throw new Error("synthetic secondary notification failure");
              return mutationResult(bound ? 4 : 3, "paused_failure");
            }
            throw new Error(`unexpected parent action ${action}`);
          },
        ),
      };
      const coordinatorClient = { send: vi.fn() };
      const startChild = vi.fn(
        async (_inputs: AppModeInputs, options: AppModeStartOptions = {}) => {
          if (bound) await options.prepareManaged!(preflight(fingerprint("8")));
          throw original;
        },
      );
      const runner = createManagedSerialSequenceRunner({
        parentClient,
        coordinatorClient,
        reattachStore: createManagedSequenceReattachStore(
          memoryStorage(),
          () => 1_000,
        ),
        startChild,
        resolveChild: async () => ({
          inputs: {
            task_mode: "t2va",
            user_intent: "synthetic",
            duration_milliseconds: 8_000,
            frame_count: 192,
          },
          workflowAuthority: {},
          activeWorkflowFingerprint: fingerprint("8"),
          previousOwnedProjectionFingerprint: fingerprint("7"),
        }),
      });
      const rejection: unknown = await runner.start(startIntent).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(startChild).toHaveBeenCalledOnce();
      expect(parentClient.send.mock.calls.map(([, action]) => action)).toEqual([
        "authorize_sequence",
        "start_sequence",
        "prepare_sequence_child",
        ...(bound ? ["bind_prepared_child"] : []),
        notificationAction,
      ]);
      expect(coordinatorClient.send).not.toHaveBeenCalled();
      const payload = parentClient.send.mock.calls.at(-1)![2];
      expect(payload).not.toHaveProperty("failure_code");
      expect(payload).not.toHaveProperty("reason");
      expect(payload).not.toHaveProperty("compileStep");
      expect(payload).not.toHaveProperty("compileAdmission");
      const notification = JSON.stringify(payload);
      for (const forbidden of [
        "compile_failed",
        "compiled_admission",
        "requested_route",
        original.message,
        "synthetic secondary notification failure",
      ])
        expect(notification).not.toContain(forbidden);
      // Assert identity last: every notification-path/no-effect precondition passed first.
      expect(rejection).toBe(original);
    },
  );
});

describe("managed ambiguous invocation reporting", () => {
  it("propagates a rejected ambiguous mark to protect against duplicate submission", async () => {
    const original = new Error("synthetic ambiguous queue acknowledgement");
    const markFailure = new Error("synthetic invocation mark failure");
    const parentClient = {
      read: vi.fn(),
      send: vi.fn(async (_id: string, action: string) => {
        if (action === "authorize_sequence")
          return mutationResult(0, "authorized");
        if (action === "start_sequence") return mutationResult(1, "active");
        if (action === "prepare_sequence_child")
          return mutationResult(2, "active", execution("segment.1", 2));
        if (action === "bind_prepared_child")
          return mutationResult(3, "active", null, {
            schema: "h3.context.managed_sequence_child_authority.v1",
            runHandle: `mc_${"d".repeat(40)}`,
            stateFingerprint: fingerprint("4"),
            jobId: "job.segment.1",
            transactionId: "transaction.segment.1",
          });
        if (action === "mark_invocation_unknown") throw markFailure;
        throw new Error(`unexpected parent action ${action}`);
      }),
    };
    const workflowAuthority = {};
    const coordinatorClient = { send: vi.fn() };
    const startChild = vi.fn(
      async (_inputs: AppModeInputs, options: AppModeStartOptions = {}) => {
        const authority = await options.prepareManaged!(
          preflight(fingerprint("9")),
        );
        authority.bindCanvasIdentity?.({
          workflowAuthority,
          ownedReference: {
            nodeIds: ["1"],
            linkIds: [],
            anchorNodeId: "1",
            authoredWidgetNodeIds: [],
          },
        });
        authority.onQueueSubmitted();
        // Exercise the outer catch without the onQueueFailed callback handling it first.
        throw original;
      },
    );
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient,
      reattachStore: createManagedSequenceReattachStore(
        memoryStorage(),
        () => 1_000,
      ),
      startChild,
      resolveChild: async () => ({
        inputs: {
          task_mode: "t2va",
          user_intent: "synthetic",
          duration_milliseconds: 8_000,
          frame_count: 192,
        },
        workflowAuthority,
        activeWorkflowFingerprint: fingerprint("8"),
        previousOwnedProjectionFingerprint: fingerprint("7"),
      }),
    });
    const rejection: unknown = await runner.start(startIntent).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(startChild).toHaveBeenCalledOnce();
    expect(parentClient.send.mock.calls.map(([, action]) => action)).toEqual([
      "authorize_sequence",
      "start_sequence",
      "prepare_sequence_child",
      "bind_prepared_child",
      "mark_invocation_unknown",
    ]);
    expect(coordinatorClient.send).not.toHaveBeenCalled();
    expect(runner.snapshot()).toMatchObject({
      parentState: "active",
      activeSegmentId: "segment.1",
    });
    expect(rejection).toBe(markFailure);
  });
});

describe("managed sequence acknowledged diagnostics", () => {
  function diagnosticRunner(
    count = 1,
    hold?: { service: "parent" | "child"; action: string; ordinal?: number },
    pauseResolver = false,
    probe?: {
      resolve?: () => Promise<void>;
      start?: () => Promise<void>;
      bind?: () => Promise<ManagedSequenceMutationResult>;
    },
  ) {
    const entered = deferred<void>();
    const acknowledgement = deferred<void>();
    const resolverEntered = deferred<void>();
    const resolver = deferred<void>();
    let revision = 0;
    let ordinal = 0;
    let queueInvocations = 0;
    const workflowAuthority = {};
    const artifacts = new Set<number>();
    const terminals = new Set<number>();
    const diagnosticResult = (
      ...args: Parameters<typeof mutationResult>
    ): ManagedSequenceMutationResult => {
      const value = mutationResult(...args);
      return probe === undefined
        ? value
        : {
            ...value,
            schema: "h3.context.managed_sequence_result.v2",
            sequenceTaskMode: "i2va",
            failureCode: null,
          };
    };
    const awaitAcknowledgement = async (
      service: "parent" | "child",
      action: string,
    ) => {
      if (
        hold?.service === service &&
        hold.action === action &&
        (hold.ordinal ?? 1) === ordinal
      ) {
        entered.resolve();
        await acknowledgement.promise;
      }
    };
    const parentClient = {
      read: vi.fn(),
      send: vi.fn(
        async (
          _id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          if (action === "prepare_sequence_child")
            ordinal = Number(String(payload.segment_id).split(".").at(-1));
          await awaitAcknowledgement("parent", action);
          if (action === "bind_prepared_child" && probe?.bind)
            return probe.bind();
          revision += 1;
          if (action === "authorize_sequence")
            return diagnosticResult(revision, "authorized");
          if (action === "prepare_sequence_child")
            return diagnosticResult(
              revision,
              "active",
              execution(
                String(payload.segment_id),
                revision,
                payload.predecessor_terminal_fingerprint as string | null,
              ),
            );
          if (action === "bind_prepared_child")
            return diagnosticResult(revision, "active", null, {
              schema: "h3.context.managed_sequence_child_authority.v1",
              runHandle: `mc_${String(ordinal).repeat(40)}`,
              stateFingerprint: fingerprint("4"),
              jobId: `job.${ordinal}`,
              transactionId: `transaction.${ordinal}`,
            });
          return diagnosticResult(
            revision,
            action === "record_terminal" && ordinal === count
              ? "succeeded"
              : "active",
          );
        },
      ),
    };
    const coordinatorClient = {
      send: vi.fn(
        async (
          _id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          await awaitAcknowledgement("child", action);
          if (action === "record_artifact") artifacts.add(ordinal);
          if (action === "record_terminal") terminals.add(ordinal);
          return coordinatorResult(
            String(payload.run_handle),
            fingerprint("5"),
            action === "release_sequence"
              ? "released"
              : action === "record_submission"
                ? "submitted"
                : artifacts.has(ordinal) && terminals.has(ordinal)
                  ? "succeeded"
                  : artifacts.has(ordinal)
                    ? "artifact_verified"
                    : "verification_pending",
            artifacts.has(ordinal)
              ? {
                  schema:
                    "h3.context.generation_coordinator.artifact_authority.v1",
                  receiptFingerprint: fingerprint("a"),
                  byteLength: 12,
                }
              : null,
            artifacts.has(ordinal) && terminals.has(ordinal)
              ? fingerprint("e")
              : null,
          );
        },
      ),
    };
    const runner = createManagedSerialSequenceRunner({
      parentClient,
      coordinatorClient,
      reattachStore: createManagedSequenceReattachStore(
        memoryStorage(),
        () => 1_000,
      ),
      resolveChild: async () => {
        await probe?.resolve?.();
        if (pauseResolver) {
          resolverEntered.resolve();
          await resolver.promise;
        }
        return {
          inputs: {
            task_mode: "t2va",
            user_intent: "synthetic",
            duration_milliseconds: 8_000,
            frame_count: 192,
          },
          workflowAuthority,
          activeWorkflowFingerprint: fingerprint("8"),
          previousOwnedProjectionFingerprint: fingerprint("0"),
        };
      },
      startChild: async (_inputs, options = {}) => {
        await probe?.start?.();
        const prepared = preflight(fingerprint("0"));
        const authority = await options.prepareManaged!(prepared);
        authority.bindCanvasIdentity?.({
          workflowAuthority,
          ownedReference: {
            nodeIds: ["1"],
            linkIds: [],
            anchorNodeId: "1",
            authoredWidgetNodeIds: [],
          },
        });
        authority.onQueueSubmitted();
        queueInvocations += 1;
        const result: AppModeStartResult = {
          queueResult: {
            prompt_id: `prompt.${ordinal}`,
            number: ordinal,
            nodeErrorClassTypes: [],
            nodeErrorTypes: [],
          },
          graphFingerprint: prepared.observation.graph_fingerprint,
          compiledPromptFingerprint:
            prepared.observation.compiled_prompt_fingerprint,
          ownedProjectionFingerprint: fingerprint("0"),
          ownedNodeIds: ["1"],
          ownedLinkIds: [],
          queuePromptId: `prompt.${ordinal}`,
          route: "existing",
        };
        await authority.onQueueAccepted(result);
        return result;
      },
    });
    const artifact = (child: number) =>
      runner.recordArtifact({
        promptId: `prompt.${child}`,
        outputNodeId: "save.1",
        locator: { filename: "synthetic.mp4", subfolder: "", type: "output" },
      });
    const terminal = (child: number) =>
      runner.recordTerminal({ promptId: `prompt.${child}`, kind: "success" });
    return {
      runner,
      entered,
      acknowledgement,
      resolverEntered,
      resolver,
      artifact,
      terminal,
      queueInvocations: () => queueInvocations,
      start: () =>
        runner.start({
          ...startIntent,
          ...(probe === undefined ? {} : { sequenceTaskMode: "i2va" as const }),
          segmentIds: Array.from(
            { length: count },
            (_, index) => `segment.${index + 1}`,
          ),
        }),
    };
  }

  describe("Stage C failure attribution", () => {
    const attribution = (value: unknown) =>
      (value as { failureAttribution?: unknown }).failureAttribution;
    const decode = (value: unknown): unknown => {
      const candidate = (
        failureDiagnostics as unknown as Record<string, unknown>
      )["decodeSequenceFailureAttribution"];
      expect(candidate).toBeTypeOf("function");
      return (candidate as (input: unknown) => unknown)(value);
    };
    const expected = (
      origin: string,
      boundary: string,
      managedAction = "unattributed",
      httpStatusClass = "unattributed",
    ) => ({ origin, boundary, managedAction, httpStatusClass });

    it.each(["graph", "source", "locator", "backend"] as const)(
      "propagates the real %s producer through a real runner without queueing",
      async (site) => {
        const fixture = sequenceFailureFixture();
        const invoke = async () => {
          if (site === "graph") {
            const guard = createPreparedSequenceGraphGuard(
              fixture.result.workflow,
              fixture.result.anchorNodeId,
              fixture.result.mediaNodeIds,
              fixture.inputs,
            );
            const nodes = fixture.result.workflow.nodes as Array<{
              type: string;
              widgets_values: Array<{ x: number }>;
            }>;
            nodes.find(
              (node) => node.type === "ImageCropV2",
            )!.widgets_values[0]!.x = 17;
            (guard as (value: unknown, boundary?: string) => void)(
              fixture.result.workflow,
              "root-write",
            );
          } else {
            const observe = sequenceFailureObserver(fixture.prepared);
            if (site === "source")
              observe.mockImplementation(async () => ({
                ...fixture.prepared.bindings!.entries[0]!.source_identity,
                source_fingerprint: fingerprint("f"),
                receipt_handle: "ig_" + "n".repeat(41),
              }));
            if (site === "locator") {
              const output = fixture.compiled.output as Record<
                string,
                { class_type: string; inputs: Record<string, unknown> }
              >;
              Object.values(output).find(
                (node) => node.class_type === "LoadImage",
              )!.inputs.image = "synthetic/changed.png";
            }
            await observePreparedSequenceMedia(
              fixture.result.workflow,
              fixture.compiled,
              fixture.result.mediaNodeIds,
              fixture.inputs,
              fixture.prepared,
              observe,
            );
          }
        };
        const backend = createManagedSequenceClient({
          fetchApi: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({
              ...mutationWire(),
              schema: "h3.context.managed_sequence_result.v2",
              state: "paused_failure",
              revision: 3,
              sequence_task_mode: "i2va",
              failure_code: "sequence_media_changed",
            }),
          }),
        });
        const ctx = diagnosticRunner(
          1,
          undefined,
          false,
          site === "backend"
            ? {
                bind: () =>
                  backend.send("synthetic.bind", "bind_prepared_child", {}),
              }
            : site === "graph"
              ? { resolve: invoke }
              : { start: invoke },
        );
        const other = diagnosticRunner();
        const before = other.runner.snapshot().diagnostics;
        await expect(ctx.start()).rejects.toMatchObject(
          site === "graph" || site === "backend"
            ? { code: "sequence_media_changed" }
            : { category: "sequence_media_changed" },
        );
        expect(attribution(ctx.runner.snapshot().diagnostics)).toEqual(
          site === "graph"
            ? expected("candidate-graph", "root-write")
            : site === "source"
              ? expected("renewed-source", "source-observe")
              : site === "locator"
                ? expected("compiled-locator", "source-observe")
                : expected(
                    "backend-comparison",
                    "managed-bind",
                    "bind_prepared_child",
                    "2xx",
                  ),
        );
        expect(ctx.runner.snapshot().activeSegmentId).toBeNull();
        expect(ctx.queueInvocations()).toBe(0);
        expect(other.runner.snapshot().diagnostics).toEqual(before);
      },
    );

    it("rejects unknown metadata and never retains response objects in the adopt error", () => {
      const closed = expected(
        "backend-comparison",
        "managed-bind",
        "bind_prepared_child",
        "2xx",
      );
      expect(decode(closed)).toEqual(closed);
      expect(
        decode({ ...closed, privateField: "synthetic-secret" }),
      ).toBeNull();
      for (const key of Object.keys(closed))
        expect(decode({ ...closed, [key]: "unknown" })).toBeNull();
      const hostile = Object.defineProperty({}, "failureAttribution", {
        get() {
          throw new Error("synthetic-secret");
        },
      });
      expect(() => decode(hostile)).not.toThrow();
      const result = {
        ...mutationResult(3, "paused_failure"),
        nested: { secret: {} },
        failureAttribution: closed,
      };
      const Constructor = ManagedSerialSequenceRunnerError as unknown as new (
        code: "sequence_media_changed",
        result: unknown,
      ) => Error;
      const error = new Constructor("sequence_media_changed", result);
      expect(Object.getOwnPropertyNames(error).sort()).toEqual([
        "code",
        "failureAttribution",
        "message",
        "name",
        "stack",
      ]);
      const references = [result, result.nested, result.nested.secret, closed];
      for (const value of Object.values(
        Object.getOwnPropertyDescriptors(error),
      ))
        for (const reference of references)
          expect(value.value).not.toBe(reference);
      expect(
        Object.getOwnPropertyDescriptor(error, "failureAttribution")
          ?.enumerable,
      ).toBe(false);
      expect(attribution(error)).toEqual(closed);
      expect(JSON.stringify(error)).not.toContain("synthetic-secret");
    });
  });

  it.each([
    ["artifactRecorded", "parent", "record_artifact"],
    ["terminalKindKnown", "child", "record_terminal"],
    ["terminalFingerprintPresent", "child", "record_terminal"],
    ["released", "child", "release_sequence"],
    ["parentTerminalRecorded", "parent", "record_terminal"],
  ] as const)(
    "sets %s only after its successful acknowledgement",
    async (flag, service, action) => {
      const ctx = diagnosticRunner(1, { service, action });
      await ctx.start();
      if (flag !== "artifactRecorded") await ctx.artifact(1);
      const operation =
        flag === "artifactRecorded" ? ctx.artifact(1) : ctx.terminal(1);
      await ctx.entered.promise;
      expect(ctx.runner.snapshot().diagnostics.gate[flag]).toBe(false);
      ctx.acknowledgement.resolve();
      await operation;
      expect(ctx.runner.snapshot().diagnostics.gate[flag]).toBe(true);
    },
  );

  it("sets successor prepared only after prepare acknowledgement and resets it at bind", async () => {
    const ctx = diagnosticRunner(
      1,
      { service: "parent", action: "prepare_sequence_child" },
      true,
    );
    const operation = ctx.start();
    await ctx.entered.promise;
    expect(ctx.runner.snapshot().diagnostics.successor).toEqual({
      ordinal: 1,
      prepared: false,
    });
    ctx.acknowledgement.resolve();
    await ctx.resolverEntered.promise;
    expect(ctx.runner.snapshot().diagnostics.successor).toEqual({
      ordinal: 1,
      prepared: true,
    });
    ctx.resolver.resolve();
    await operation;
    expect(ctx.runner.snapshot().diagnostics.successor).toEqual({
      ordinal: null,
      prepared: false,
    });
    expect(ctx.runner.snapshot().diagnostics.gate).toEqual(
      emptySequenceGate(1),
    );
  });

  it("retains child two's acknowledged gate while child three prepare is pending", async () => {
    const ctx = diagnosticRunner(3, {
      service: "parent",
      action: "prepare_sequence_child",
      ordinal: 3,
    });
    await ctx.start();
    await ctx.artifact(1);
    await ctx.terminal(1);
    await ctx.artifact(2);
    const operation = ctx.terminal(2);
    await ctx.entered.promise;
    expect(ctx.runner.snapshot().diagnostics).toEqual({
      parentState: "active",
      failureAttribution: {
        origin: "unattributed",
        boundary: "unattributed",
        managedAction: "unattributed",
        httpStatusClass: "unattributed",
      },
      activeChildOrdinal: null,
      gate: {
        childOrdinal: 2,
        artifactRecorded: true,
        terminalKindKnown: true,
        terminalFingerprintPresent: true,
        released: true,
        parentTerminalRecorded: true,
      },
      successor: { ordinal: 3, prepared: false },
    });
    ctx.acknowledgement.resolve();
    await operation;
    expect(ctx.runner.snapshot().diagnostics.gate).toEqual(
      emptySequenceGate(3),
    );
    expect(ctx.runner.snapshot().diagnostics.activeChildOrdinal).toBe(3);
  });

  it("keeps terminal-first fingerprint absent until acknowledged artifact authority arrives", async () => {
    const ctx = diagnosticRunner();
    await ctx.start();
    await ctx.terminal(1);
    expect(ctx.runner.snapshot().diagnostics.gate).toMatchObject({
      terminalKindKnown: true,
      terminalFingerprintPresent: false,
      artifactRecorded: false,
      released: false,
      parentTerminalRecorded: false,
    });
    await ctx.artifact(1);
    expect(ctx.runner.snapshot().diagnostics.gate).toEqual({
      childOrdinal: 1,
      artifactRecorded: true,
      terminalKindKnown: true,
      terminalFingerprintPresent: true,
      released: true,
      parentTerminalRecorded: true,
    });
  });

  it("never records release or parent terminal success for a rejected release", async () => {
    const ctx = diagnosticRunner(1, {
      service: "child",
      action: "release_sequence",
    });
    await ctx.start();
    await ctx.artifact(1);
    const rejection = expect(ctx.terminal(1)).rejects.toThrow(
      "synthetic refusal",
    );
    await ctx.entered.promise;
    ctx.acknowledgement.reject(new Error("synthetic refusal"));
    await rejection;
    expect(ctx.runner.snapshot().diagnostics.gate).toMatchObject({
      released: false,
      parentTerminalRecorded: false,
    });
  });

  it("keeps diagnostic observations isolated between two real runners", async () => {
    const first = diagnosticRunner();
    const second = diagnosticRunner();
    const unchanged = second.runner.snapshot().diagnostics;
    await first.start();
    await first.artifact(1);
    await first.terminal(1);
    expect(
      first.runner.snapshot().diagnostics.gate.parentTerminalRecorded,
    ).toBe(true);
    expect(second.runner.snapshot().diagnostics).toEqual(unchanged);
  });

  it("closes ordinal and failure-code domains without leaking hostile typed error strings", () => {
    expect([-1, 0, 1, 2, 3, 4].map(sequenceChildOrdinal)).toEqual([
      null,
      1,
      2,
      3,
      null,
      null,
    ]);
    expect(sequenceDiagnosticFailure(null)).toBeNull();
    expect(sequenceDiagnosticFailure("managed_sequence_rejected")).toBe(
      "managed_sequence_rejected",
    );
    for (const value of [
      "private/prompt/value",
      "sha256:private",
      "https://private.invalid",
      undefined,
      {},
    ])
      expect(sequenceDiagnosticFailure(value)).toBe("managed_sequence_failed");
  });
});
