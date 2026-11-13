import type { AppModeRefusalReason } from "./appModeContract";
import { withSequenceFailureAttribution } from "./managedSequenceDiagnostics";

function freezeRefusalReason(
  reason: AppModeRefusalReason,
): AppModeRefusalReason {
  // CRITICAL: only this closed vocabulary may cross into UI state. Never retain
  // host exception text, paths, model names or media identities as refusal data.
  if (reason.kind === "generation_admission_refused")
    return Object.freeze({
      kind: reason.kind,
      admissionReason: reason.admissionReason,
      unsatisfiedSlots: Object.freeze([...reason.unsatisfiedSlots]),
    });
  if (reason.kind === "anchor_missing")
    return Object.freeze({
      kind: reason.kind,
      requiredNode: reason.requiredNode,
    });
  if (reason.kind === "queue_rejected")
    return Object.freeze({
      kind: reason.kind,
      classTypes: Object.freeze([...reason.classTypes]),
      errorTypes: Object.freeze([...reason.errorTypes]),
    });
  return Object.freeze({ kind: reason.kind });
}

const appModeCompileSteps = [
  "materialized_identity",
  "root_write",
  "root_write_bootstrap",
  "loaded_compile",
  "post_compile_check",
  "compiled_admission",
  "compiled_fingerprint",
] as const;

export type AppModeCompileStep = (typeof appModeCompileSteps)[number];

const appModeCompileAdmissions = [
  "envelope",
  "compatibility",
  "requested_route",
] as const;

export type AppModeCompileAdmission = (typeof appModeCompileAdmissions)[number];

/** Preserve the same corrective action while copying only closed diagnostic scalars. */
export function sequenceMediaAppModeError(
  code: "sequence_media_changed" | "sequence_media_unavailable",
  attribution: unknown,
): AppModeError {
  return new AppModeError(
    code,
    "reselect the declared frame source and retry the sequence",
    undefined,
    undefined,
    undefined,
    attribution,
  );
}

export class AppModeError extends Error {
  readonly code:
    | "incompatible_seam"
    | "incompatible_graph"
    | "dirty_graph"
    | "invalid_request"
    | "reference_capacity_exceeded"
    | "compile_failed"
    | "queue_failed"
    | "sequence_media_changed"
    | "sequence_media_unavailable"
    | "execution_failed"
    | "execution_interrupted"
    | "ambiguous_host_ownership"
    | "cancelled"
    | "stale_graph"
    | "rollback_failed";
  readonly source:
    "request" | "seam" | "graph" | "compile" | "queue" | "transaction";
  readonly recovery: "retry" | "inspect" | "use_native";
  readonly reason?: AppModeRefusalReason;
  // IMPORTANT: diagnostic-only origin; UI/backend schemas do not admit this field.
  // Do not display or forward it until the bounded D-E125-2 reporting change.
  declare readonly compileStep?: AppModeCompileStep;
  declare readonly compileAdmission?: AppModeCompileAdmission;

  constructor(
    code: AppModeError["code"],
    message: string,
    reason?: AppModeRefusalReason,
    compileStep?: AppModeCompileStep,
    compileAdmission?: AppModeCompileAdmission,
    failureAttribution?: unknown,
  ) {
    // Keep provider/graph errors out of the UI and logs; only stable codes and
    // bounded, user-safe messages cross the sidebar seam.
    super(`${code}: ${message}`);
    this.name = "AppModeError";
    this.code = code;
    withSequenceFailureAttribution(this, failureAttribution);
    this.reason =
      reason === undefined ? undefined : freezeRefusalReason(reason);
    this.source =
      code === "incompatible_seam"
        ? "seam"
        : code === "incompatible_graph" || code === "dirty_graph"
          ? "graph"
          : code === "compile_failed"
            ? "compile"
            : code === "queue_failed"
              ? "queue"
              : code === "execution_failed" ||
                  code === "execution_interrupted" ||
                  code === "stale_graph" ||
                  code === "rollback_failed" ||
                  code === "ambiguous_host_ownership"
                ? "transaction"
                : "request";
    this.recovery =
      reason?.kind === "queue_rejected"
        ? "inspect"
        : reason?.kind === "queue_response_invalid"
          ? "use_native"
          : code === "dirty_graph" || code === "incompatible_graph"
            ? "inspect"
            : code === "incompatible_seam" ||
                code === "ambiguous_host_ownership"
              ? "use_native"
              : "retry";
    if (
      code === "compile_failed" &&
      compileStep !== undefined &&
      appModeCompileSteps.includes(compileStep)
    ) {
      Object.defineProperty(this, "compileStep", {
        value: compileStep,
        enumerable: false,
      });
      // IMPORTANT: admit only the closed predicate family before freezing; an
      // enumerable or open detail would leak through existing UI/backend copies.
      if (
        compileStep === "compiled_admission" &&
        compileAdmission !== undefined &&
        appModeCompileAdmissions.includes(compileAdmission)
      )
        Object.defineProperty(this, "compileAdmission", {
          value: compileAdmission,
          enumerable: false,
        });
      Object.freeze(this);
    }
  }
}
