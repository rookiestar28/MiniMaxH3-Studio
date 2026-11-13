import { expect, it } from "vitest";
import {
  createSequenceSubmissionAttribution,
  parseSequenceDiagnosticAttributes,
} from "./e2e/host/frameSequenceDiagnostics";

const values = {
  "parent-state": "active",
  "active-child-ordinal": "null",
  "gate-child-ordinal": "2",
  "gate-artifact-recorded": "true",
  "gate-terminal-kind-known": "true",
  "gate-terminal-fingerprint-present": "true",
  "gate-released": "true",
  "gate-parent-terminal-recorded": "true",
  "successor-ordinal": "3",
  "successor-prepared": "false",
  "failure-code": "null",
  "failure-origin": "unattributed",
  "failure-boundary": "unattributed",
  "failure-managed-action": "unattributed",
  "failure-http-status-class": "unattributed",
  "ui-state": "detach_ready",
};
const snapshot = parseSequenceDiagnosticAttributes(values)!;

it("accepts only the exact closed content-free snapshot", () => {
  expect(snapshot).not.toBeNull();
  expect(snapshot.gate.childOrdinal).toBe(2);
  expect(snapshot.successor).toEqual({ ordinal: 3, prepared: false });
  expect(
    parseSequenceDiagnosticAttributes({ ...values, extra: "private" }),
  ).toBeNull();
});

it.each([
  ["parent-state", "private"],
  ["active-child-ordinal", "4"],
  ["gate-released", "pending"],
  ["failure-code", "private/prompt"],
  ["ui-state", "private"],
  ["successor-prepared", null],
  ["failure-origin", "private"],
  ["failure-boundary", "private"],
  ["failure-managed-action", "private"],
  ["failure-http-status-class", "private"],
])("rejects unknown or missing %s diagnostic values", (key, value) => {
  expect(
    parseSequenceDiagnosticAttributes({ ...values, [key!]: value }),
  ).toBeNull();
});

function attribution() {
  const tracker = createSequenceSubmissionAttribution();
  tracker.plan("plan-private", [
    "segment-private-A",
    "segment-private-B",
    "segment-private-C",
  ]);
  tracker.authorize("parent-private", "plan-private");
  tracker.bootstrap("bootstrap-private");
  tracker.prompt("bootstrap-private");
  return tracker;
}

it("joins out-of-order responses to real segment identity and persists ordinals only", () => {
  const tracker = attribution();
  tracker.prompt("prompt-private-B");
  tracker.prompt("prompt-private-A");
  tracker.submission("parent-private", "segment-private-A", "prompt-private-A");
  tracker.submission("parent-private", "segment-private-B", "prompt-private-B");
  const report = tracker.report(snapshot);
  expect(report.submissions).toEqual(["BOOTSTRAP", 2, 1]);
  expect(report.disposition).toBe("OBSERVED");
  expect(JSON.stringify(report)).not.toContain("private");
});

it.each([
  "unjoined",
  "unknown segment",
  "wrong plan",
  "conflict",
  "missing response",
  "missing snapshot",
])(
  "marks %s as a diagnostic QUESTION without inventing an ordinal or product verdict",
  (gap) => {
    const tracker = attribution();
    if (gap !== "missing response") tracker.prompt("prompt-private");
    if (gap === "wrong plan") tracker.authorize("parent-private", "other-plan");
    if (gap !== "unjoined")
      tracker.submission(
        "parent-private",
        gap === "unknown segment" ? "unknown" : "segment-private-A",
        "prompt-private",
      );
    if (gap === "conflict")
      tracker.submission(
        "parent-private",
        "segment-private-B",
        "prompt-private",
      );
    const report = tracker.report(gap === "missing snapshot" ? null : snapshot);
    expect(report.disposition).toBe("QUESTION");
    if (!["missing response", "missing snapshot"].includes(gap))
      expect(report.submissions.at(-1)).toBe("UNATTRIBUTED");
    expect(Object.hasOwn(report, "productStatus")).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private");
  },
);
