import type { SequenceRunnerDiagnostics } from "../../../src/host/managedSequenceDiagnostics";
import {
  decodeSequenceFailureAttribution,
  sequenceDiagnosticFailure,
} from "../../../src/host/managedSequenceDiagnostics";
import type { NleSequenceUiState } from "../../../src/state/nleWorkspaceState";

export const sequenceDiagnosticAttributes = [
  "parent-state",
  "active-child-ordinal",
  "gate-child-ordinal",
  "gate-artifact-recorded",
  "gate-terminal-kind-known",
  "gate-terminal-fingerprint-present",
  "gate-released",
  "gate-parent-terminal-recorded",
  "successor-ordinal",
  "successor-prepared",
  "failure-code",
  "ui-state",
  "failure-origin",
  "failure-boundary",
  "failure-managed-action",
  "failure-http-status-class",
] as const;

type ClosedSnapshot = SequenceRunnerDiagnostics &
  Readonly<{
    failureCode: ReturnType<typeof sequenceDiagnosticFailure>;
    uiState: NleSequenceUiState;
  }>;

export function parseSequenceDiagnosticAttributes(
  values: Record<string, string | null>,
): ClosedSnapshot | null {
  if (
    Object.keys(values).length !== sequenceDiagnosticAttributes.length ||
    sequenceDiagnosticAttributes.some((key) => !Object.hasOwn(values, key))
  )
    return null;
  const parentStates = [
    "null",
    "authorized",
    "active",
    "paused_client_absent",
    "paused_unknown_ownership",
    "paused_canvas_drift",
    "paused_failure",
    "cancelled",
    "succeeded",
  ];
  const uiStates: readonly string[] = [
    "idle",
    "starting",
    "attached_current_child",
    "detach_ready",
    "detaching",
    "safe_to_leave",
    "reattach_reconciling",
    "current_segment_completed",
    "current_segment_still_owned",
    "paused_unknown_ownership",
    "resume_ready",
    "recovery_unavailable_or_expired",
    "finished",
    "failed",
  ];
  const ordinals = [
    "active-child-ordinal",
    "gate-child-ordinal",
    "successor-ordinal",
  ];
  const flags = [
    "gate-artifact-recorded",
    "gate-terminal-kind-known",
    "gate-terminal-fingerprint-present",
    "gate-released",
    "gate-parent-terminal-recorded",
    "successor-prepared",
  ];
  if (
    !parentStates.includes(values["parent-state"] ?? "") ||
    !uiStates.includes(values["ui-state"] ?? "") ||
    ordinals.some(
      (key) => !["1", "2", "3", "null"].includes(values[key] ?? ""),
    ) ||
    flags.some((key) => values[key] !== "true" && values[key] !== "false")
  )
    return null;
  const failureCode =
    values["failure-code"] === "null"
      ? null
      : sequenceDiagnosticFailure(values["failure-code"]);
  if ((failureCode ?? "null") !== values["failure-code"]) return null;
  const failureAttribution = decodeSequenceFailureAttribution({
    origin: values["failure-origin"],
    boundary: values["failure-boundary"],
    managedAction: values["failure-managed-action"],
    httpStatusClass: values["failure-http-status-class"],
  });
  if (failureAttribution === null) return null;
  const ordinal = (key: string): 1 | 2 | 3 | null =>
    values[key] === "null" ? null : (Number(values[key]) as 1 | 2 | 3);
  return {
    failureAttribution,
    parentState:
      values["parent-state"] === "null"
        ? null
        : (values["parent-state"] as SequenceRunnerDiagnostics["parentState"]),
    activeChildOrdinal: ordinal("active-child-ordinal"),
    gate: {
      childOrdinal: ordinal("gate-child-ordinal"),
      artifactRecorded: values["gate-artifact-recorded"] === "true",
      terminalKindKnown: values["gate-terminal-kind-known"] === "true",
      terminalFingerprintPresent:
        values["gate-terminal-fingerprint-present"] === "true",
      released: values["gate-released"] === "true",
      parentTerminalRecorded:
        values["gate-parent-terminal-recorded"] === "true",
    },
    successor: {
      ordinal: ordinal("successor-ordinal"),
      prepared: values["successor-prepared"] === "true",
    },
    failureCode,
    uiState: values["ui-state"] as NleSequenceUiState,
  };
}

/** IDs stay in memory. Only exact approved-plan joins can produce persisted ordinals. */
export function createSequenceSubmissionAttribution() {
  let plan: { fingerprint: string; segments: readonly string[] } | null = null;
  let bootstrap: string | null = null;
  const parents = new Map<string, string>();
  const submissions = new Map<
    string,
    Array<{ parent: string; segment: string }>
  >();
  const prompts: string[] = [];
  let gap = false;
  return {
    plan(fingerprint: string, segments: readonly string[]) {
      plan = { fingerprint, segments: [...segments] };
    },
    bootstrap(prompt: string) {
      bootstrap = prompt;
    },
    prompt(prompt: string) {
      prompts.push(prompt);
    },
    authorize(parent: string, fingerprint: string) {
      parents.set(parent, fingerprint);
    },
    submission(parent: string, segment: string, prompt: string) {
      const rows = submissions.get(prompt) ?? [];
      if (!rows.some((row) => row.parent === parent && row.segment === segment))
        rows.push({ parent, segment });
      submissions.set(prompt, rows);
    },
    unavailable() {
      gap = true;
    },
    report(snapshot: ClosedSnapshot | null) {
      const attribution = prompts.map(
        (prompt): 1 | 2 | 3 | "BOOTSTRAP" | "UNATTRIBUTED" => {
          if (prompt === bootstrap)
            return submissions.has(prompt) ? "UNATTRIBUTED" : "BOOTSTRAP";
          const rows = submissions.get(prompt);
          if (
            plan === null ||
            rows?.length !== 1 ||
            parents.get(rows[0]!.parent) !== plan.fingerprint
          )
            return "UNATTRIBUTED";
          const index = plan.segments.indexOf(rows[0]!.segment);
          return index === 0
            ? 1
            : index === 1
              ? 2
              : index === 2
                ? 3
                : "UNATTRIBUTED";
        },
      );
      const missing =
        gap ||
        snapshot === null ||
        bootstrap === null ||
        plan === null ||
        (bootstrap !== null && !prompts.includes(bootstrap)) ||
        new Set(plan.segments).size !== plan.segments.length ||
        new Set(prompts).size !== prompts.length ||
        attribution.includes("UNATTRIBUTED") ||
        [...submissions.keys()].some((prompt) => !prompts.includes(prompt));
      return {
        snapshot,
        submissions: attribution,
        disposition: missing ? ("QUESTION" as const) : ("OBSERVED" as const),
      };
    },
  };
}
