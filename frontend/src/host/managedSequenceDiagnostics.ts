import type { ManagedSequenceState } from "./managedSequenceClient";

export type SequenceFailureAttribution = Readonly<{
  origin:
    | "unattributed"
    | "media-shape"
    | "media-selector"
    | "media-crop"
    | "visible-guide"
    | "compiled-guide"
    | "blueprint"
    | "compiled-locator"
    | "retained-binding"
    | "candidate-graph"
    | "observation-graph"
    | "renewed-source"
    | "backend-comparison";
  boundary:
    | "unattributed"
    | "materialize"
    | "root-write"
    | "post-compile"
    | "source-observe"
    | "managed-bind"
    | "pre-queue";
  managedAction:
    | "unattributed"
    | "start_sequence"
    | "prepare_sequence_child"
    | "bind_prepared_child";
  httpStatusClass: "unattributed" | "2xx" | "4xx" | "5xx";
}>;

/** Pure closed decoder: never retain response/error objects or copy unknown fields. */
export const decodeSequenceFailureAttribution = (
  value: unknown,
): SequenceFailureAttribution | null => {
  try {
    if (value === null || typeof value !== "object") return null;
    const envelope = value as { failureAttribution?: unknown };
    const candidate = envelope.failureAttribution ?? value;
    if (candidate === null || typeof candidate !== "object") return null;
    const row = candidate as Record<string, unknown>;
    for (const key in row)
      if (
        key !== "origin" &&
        key !== "boundary" &&
        key !== "managedAction" &&
        key !== "httpStatusClass"
      )
        return null;
    const { origin, boundary, managedAction, httpStatusClass } = row;
    if (
      origin !== "unattributed" &&
      origin !== "media-shape" &&
      origin !== "media-selector" &&
      origin !== "media-crop" &&
      origin !== "visible-guide" &&
      origin !== "compiled-guide" &&
      origin !== "blueprint" &&
      origin !== "compiled-locator" &&
      origin !== "retained-binding" &&
      origin !== "candidate-graph" &&
      origin !== "observation-graph" &&
      origin !== "renewed-source" &&
      origin !== "backend-comparison"
    )
      return null;
    if (
      boundary !== "unattributed" &&
      boundary !== "materialize" &&
      boundary !== "root-write" &&
      boundary !== "post-compile" &&
      boundary !== "source-observe" &&
      boundary !== "managed-bind" &&
      boundary !== "pre-queue"
    )
      return null;
    if (
      managedAction !== "unattributed" &&
      managedAction !== "start_sequence" &&
      managedAction !== "prepare_sequence_child" &&
      managedAction !== "bind_prepared_child"
    )
      return null;
    if (
      httpStatusClass !== "unattributed" &&
      httpStatusClass !== "2xx" &&
      httpStatusClass !== "4xx" &&
      httpStatusClass !== "5xx"
    )
      return null;
    return Object.freeze({ origin, boundary, managedAction, httpStatusClass });
  } catch {
    // CRITICAL: diagnostic reads, including hostile getters, cannot replace the failure.
    return null;
  }
};

export function withSequenceFailureAttribution<T extends object>(
  target: T,
  value: unknown,
): T {
  const attribution = decodeSequenceFailureAttribution(value);
  if (attribution !== null)
    Object.defineProperty(target, "failureAttribution", {
      value: attribution,
      enumerable: false,
    });
  return target;
}

export type SequenceChildOrdinal = 1 | 2 | 3 | null;

export type SequenceGateDiagnostics = Readonly<{
  childOrdinal: SequenceChildOrdinal;
  artifactRecorded: boolean;
  terminalKindKnown: boolean;
  terminalFingerprintPresent: boolean;
  released: boolean;
  parentTerminalRecorded: boolean;
}>;

export type SequenceRunnerDiagnostics = Readonly<{
  failureAttribution: SequenceFailureAttribution;
  parentState: ManagedSequenceState | null;
  activeChildOrdinal: SequenceChildOrdinal;
  gate: SequenceGateDiagnostics;
  successor: Readonly<{ ordinal: SequenceChildOrdinal; prepared: boolean }>;
}>;

export function sequenceChildOrdinal(index: number): SequenceChildOrdinal {
  return index === 0 ? 1 : index === 1 ? 2 : index === 2 ? 3 : null;
}

export function emptySequenceGate(
  childOrdinal: SequenceChildOrdinal = null,
): SequenceGateDiagnostics {
  return Object.freeze({
    childOrdinal,
    artifactRecorded: false,
    terminalKindKnown: false,
    terminalFingerprintPresent: false,
    released: false,
    parentTerminalRecorded: false,
  });
}

const failureCodes = [
  "already_started",
  "invalid_start_intent",
  "pointer_unavailable",
  "sequence_unavailable",
  "child_authority_mismatch",
  "workflow_identity_changed",
  "queue_callback_incomplete",
  "terminal_authority_unavailable",
  "child_release_refused",
  "sequence_media_changed",
  "sequence_media_unavailable",
  "compile_failed",
  "managed_sequence_rejected",
  "managed_sequence_failed",
] as const;

export type SequenceDiagnosticFailure = (typeof failureCodes)[number];

export function sequenceDiagnosticFailure(
  code: unknown,
): SequenceDiagnosticFailure | null {
  if (code === null) return null;
  // CRITICAL: typed client errors still carry strings; never reflect arbitrary host detail.
  return (
    failureCodes.find((known) => known === code) ?? "managed_sequence_failed"
  );
}

export function emptySequenceDiagnostics(): SequenceRunnerDiagnostics {
  return Object.freeze({
    failureAttribution: Object.freeze({
      origin: "unattributed",
      boundary: "unattributed",
      managedAction: "unattributed",
      httpStatusClass: "unattributed",
    }),
    parentState: null,
    activeChildOrdinal: null,
    gate: emptySequenceGate(),
    successor: Object.freeze({ ordinal: null, prepared: false }),
  });
}

/** Each runner owns this recorder; observation never becomes execution authority. */
export function createSequenceDiagnosticsRecorder() {
  // CRITICAL: keep mutable observations inside this factory. Sharing them across runners leaks
  // another parent's progress; only snapshot may read them outside their own updates.
  let diagnosticGate = emptySequenceGate();
  let diagnosticSuccessor: SequenceRunnerDiagnostics["successor"] =
    Object.freeze({ ordinal: null, prepared: false });
  let diagnosticRecoveredActive: SequenceChildOrdinal = null;
  let diagnosticFailure: SequenceFailureAttribution = Object.freeze({
    origin: "unattributed",
    boundary: "unattributed",
    managedAction: "unattributed",
    httpStatusClass: "unattributed",
  });

  return Object.freeze({
    failure(error: unknown): void {
      diagnosticFailure =
        decodeSequenceFailureAttribution(error) ??
        Object.freeze({
          origin: "unattributed",
          boundary: "unattributed",
          managedAction: "unattributed",
          httpStatusClass: "unattributed",
        });
    },
    preparing(index: number): void {
      diagnosticSuccessor = Object.freeze({
        ordinal: sequenceChildOrdinal(index),
        prepared: false,
      });
    },
    prepared(index: number): void {
      diagnosticSuccessor = Object.freeze({
        ordinal: sequenceChildOrdinal(index),
        prepared: true,
      });
    },
    bind(index: number): void {
      diagnosticRecoveredActive = null;
      diagnosticGate = emptySequenceGate(sequenceChildOrdinal(index));
      diagnosticSuccessor = Object.freeze({ ordinal: null, prepared: false });
    },
    artifactRecorded(): void {
      diagnosticGate = Object.freeze({
        ...diagnosticGate,
        artifactRecorded: true,
      });
    },
    fingerprintObserved(present: boolean): void {
      diagnosticGate = Object.freeze({
        ...diagnosticGate,
        terminalFingerprintPresent: present,
      });
    },
    terminalObserved(present: boolean): void {
      diagnosticGate = Object.freeze({
        ...diagnosticGate,
        terminalKindKnown: true,
        terminalFingerprintPresent: present,
      });
    },
    released(): void {
      diagnosticGate = Object.freeze({ ...diagnosticGate, released: true });
    },
    parentTerminalRecorded(): void {
      diagnosticGate = Object.freeze({
        ...diagnosticGate,
        parentTerminalRecorded: true,
      });
    },
    recoverActive(index: number): void {
      diagnosticRecoveredActive = sequenceChildOrdinal(index);
      diagnosticSuccessor = Object.freeze({ ordinal: null, prepared: false });
    },
    recoverGate(
      index: number,
      artifactRecorded: boolean,
      terminalAcknowledged = false,
    ): void {
      diagnosticGate = Object.freeze({
        ...emptySequenceGate(sequenceChildOrdinal(index)),
        artifactRecorded,
        terminalKindKnown: terminalAcknowledged,
        terminalFingerprintPresent: terminalAcknowledged,
      });
    },
    clearRecoveredActive(): void {
      diagnosticRecoveredActive = null;
    },
    snapshot(
      parentState: ManagedSequenceState | null,
      activeIndex: number | null,
    ): SequenceRunnerDiagnostics {
      return Object.freeze({
        parentState,
        failureAttribution: diagnosticFailure,
        activeChildOrdinal:
          activeIndex === null
            ? diagnosticRecoveredActive
            : sequenceChildOrdinal(activeIndex),
        gate: diagnosticGate,
        successor: diagnosticSuccessor,
      });
    },
  });
}
