import type { ComfyPromptHistoryObservationV1 } from "./comfyPromptHistory";
import type {
  AppModeInputs,
  AppModeStartOptions,
  AppModeStartResult,
  ProductionCanonicalLowering,
} from "./appMode";
import type {
  SequenceCoordinatorAction,
  SequenceCoordinatorResult,
} from "./sequenceCoordinator";
import type { SaveVideoArtifactEvent } from "./sidebarHost";
import type { SequenceMediaBindingSet } from "./sequenceMediaBindings";
import {
  createManagedSequenceReattachStore,
  type EligibleSegmentExecution,
  type ManagedSequenceAction,
  type ManagedSequenceChildAuthority,
  type ManagedSequenceMutationResult,
  type ManagedSequenceProjection,
  type ManagedSequenceState,
} from "./managedSequenceClient";

export type ManagedSequenceAuthorizationIntent = Readonly<{
  workspace_handle: string;
  expected_workspace_revision: number;
  expected_workspace_fingerprint: string;
  expected_plan_fingerprint: string;
  generation_plan_fingerprint: string;
  compiler_fingerprint: string;
  host_capability_fingerprint: string;
  explicit_intent: "generate_approved_sequence";
}>;

export type ManagedSerialSequenceStartIntent = Readonly<{
  authorization: ManagedSequenceAuthorizationIntent;
  qualificationFingerprint: string;
  segmentIds: readonly string[];
  sequenceTaskMode?: "t2va" | "i2va" | "l2va" | "fl2va";
  mediaBindings?: SequenceMediaBindingSet;
}>;

type RunnerOwnedStartOptions = Omit<
  AppModeStartOptions,
  | "prepareManaged"
  | "expectedIdentity"
  | "onQueueSubmitted"
  | "preparedCanonicalPrompt"
  | "preparedSequenceMedia"
>;

export type ManagedSerialChildPlan = Readonly<{
  inputs: AppModeInputs;
  options?: RunnerOwnedStartOptions;
  canonicalLowering?: ProductionCanonicalLowering;
  preparedSequenceMedia?: import("./preparedSequenceMedia").PreparedSequenceMedia;
  workflowAuthority: object;
  activeWorkflowFingerprint: string;
  previousOwnedProjectionFingerprint: string;
}>;

export type ManagedSerialArtifactObservation = Readonly<{
  promptId: string;
  outputNodeId: string;
  locator: SaveVideoArtifactEvent["locator"];
}>;

export type ManagedSerialReuseAuthority = Readonly<{
  artifactReceiptFingerprint: string;
  byteLength: number;
  terminalFingerprint: string;
}>;

export type ManagedSerialReattachDisposition =
  | "recovery_unavailable"
  | "current"
  | "waiting_for_current_child"
  | "artifact_authority_unavailable"
  | "resumable"
  | "terminal_reconciled";

export type ManagedSerialReattachResult = Readonly<{
  disposition: ManagedSerialReattachDisposition;
  parentState: ManagedSequenceState | null;
  activePromptId: string | null;
}>;

export type ManagedParentClient = Readonly<{
  send(
    requestId: string,
    action: ManagedSequenceAction,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ManagedSequenceMutationResult>;
  read(
    parentSequenceId: string,
    readAuthorityFingerprint: string,
    ifNoneMatch?: string,
    signal?: AbortSignal,
  ): Promise<
    Readonly<{
      status: 200 | 304;
      etag: string;
      projection: ManagedSequenceProjection | null;
    }>
  >;
}>;

export type ChildCoordinatorClient = Readonly<{
  send(
    requestId: string,
    action: SequenceCoordinatorAction,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SequenceCoordinatorResult>;
}>;

export type PromptHistoryClient = Readonly<{
  read(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<ComfyPromptHistoryObservationV1>;
}>;

export type ManagedReattachStore = ReturnType<
  typeof createManagedSequenceReattachStore
>;

export type ManagedSerialAppModeStart = (
  inputs: AppModeInputs,
  options?: AppModeStartOptions,
) => Promise<AppModeStartResult>;

export type ManagedSerialResolveReuse = (
  segmentId: string,
  index: number,
) => Promise<ManagedSerialReuseAuthority | null>;

export type ManagedSerialResolveChild = (
  execution: EligibleSegmentExecution,
  contextWorkspaceHandle: string,
  index: number,
) => Promise<ManagedSerialChildPlan>;

export type ParentAuthority = Readonly<{
  parentSequenceId: string;
  authorizationFingerprint: string;
  readAuthorityFingerprint: string;
  state: ManagedSequenceState;
  revision: number;
  parentExpiresAtEpochMs: number | null;
}>;

export type ActiveSerialChild = {
  execution: EligibleSegmentExecution;
  child: ManagedSequenceChildAuthority;
  plan: ManagedSerialChildPlan;
  coordinator: SequenceCoordinatorResult | null;
  queuePromptId: string | null;
  timeoutMs: number;
  writtenOwnedProjectionFingerprint: string | null;
  runningChildRecorded: boolean;
  runningRecorded: boolean;
  artifactChildRecorded: boolean;
  artifactRecordedByParent: boolean;
  terminalChildRecorded: boolean;
  terminalKind: "success" | "error" | "interrupted" | null;
  terminalFingerprint: string | null;
  childReleased: boolean;
};

export type ReattachedTerminal = {
  segmentId: string;
  attemptEpoch: number;
  runHandle: string;
  queuePromptId: string;
  kind: "success" | "error" | "interrupted";
  result: SequenceCoordinatorResult;
  childReleased: boolean;
};

import { withSequenceFailureAttribution } from "./managedSequenceDiagnostics";

export class ManagedSerialSequenceRunnerError extends Error {
  readonly code:
    | "already_started"
    | "invalid_start_intent"
    | "pointer_unavailable"
    | "sequence_unavailable"
    | "child_authority_mismatch"
    | "workflow_identity_changed"
    | "queue_callback_incomplete"
    | "terminal_authority_unavailable"
    | "child_release_refused"
    | "sequence_media_changed"
    | "sequence_media_unavailable";

  constructor(
    code: ManagedSerialSequenceRunnerError["code"],
    attribution?: unknown,
  ) {
    super(code);
    this.name = "ManagedSerialSequenceRunnerError";
    this.code = code;
    // CRITICAL: decode immediately; retaining the response would retain private execution data.
    withSequenceFailureAttribution(this, attribution);
  }
}

export type ManagedSerialSequenceRunnerDependencies = {
  parentClient: ManagedParentClient;
  coordinatorClient: ChildCoordinatorClient;
  reattachStore: ManagedReattachStore;
  startChild: ManagedSerialAppModeStart;
  historyClient?: PromptHistoryClient;
  resolveReuse?: ManagedSerialResolveReuse;
  resolveChild: ManagedSerialResolveChild;
};

export function assertManagedSerialSequenceRunnerDependencies({
  parentClient,
  coordinatorClient,
  reattachStore,
  startChild,
  resolveChild,
  resolveReuse,
}: ManagedSerialSequenceRunnerDependencies): void {
  if (
    typeof parentClient?.send !== "function" ||
    typeof coordinatorClient?.send !== "function" ||
    typeof reattachStore?.replace !== "function" ||
    typeof startChild !== "function" ||
    typeof resolveChild !== "function" ||
    (resolveReuse !== undefined && typeof resolveReuse !== "function")
  )
    throw new Error("managed serial runner dependency is unavailable");
}
