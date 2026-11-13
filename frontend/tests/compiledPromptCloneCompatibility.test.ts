import { describe, expect, it } from "vitest";

import {
  buildManagedAppModePreparation,
  type AppModeInputs,
} from "../src/host/appMode";
import { cloneQueueEnvelope } from "../src/host/queueSeam";
import { createQualifiedBasePrompt } from "./support/qualifiedBasePrompt";
import { hostCompiledPrompt } from "./support/hostCompiledPrompt";

class LegacyWidgetValue {
  constructor(public value: number) {}
}

const inputs: AppModeInputs = {
  task_mode: "t2va",
  user_intent: "Synthetic legacy compiled value compatibility.",
  duration_milliseconds: 8_000,
  frame_count: 192,
};
const ownedGraph = Object.freeze({
  nodeIds: Object.freeze(["1", "8", "45"]),
  linkIds: Object.freeze(["15", "17", "18"]),
  anchorNodeId: "6",
  fingerprint: `sha256:${"b".repeat(64)}`,
});

function prompt(value: unknown) {
  const output = createQualifiedBasePrompt(inputs) as Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  >;
  output["1"]!.inputs.legacy_widget = value;
  return hostCompiledPrompt(output, {});
}

function prepare(compiled: ReturnType<typeof prompt>) {
  return buildManagedAppModePreparation(
    compiled,
    inputs,
    "replace",
    "sha256:" + "a".repeat(64),
    ownedGraph,
  );
}

const legacyCases = [
  { name: "non-finite number", create: () => Number.POSITIVE_INFINITY },
  { name: "Date", create: () => new Date("2026-01-02T03:04:05Z") },
  { name: "custom prototype", create: () => new LegacyWidgetValue(7) },
];

describe("legacy structured clone compatibility", () => {
  it.each(legacyCases)(
    "preserves the accepted queue copy for $name",
    ({ create }) => {
      const compiled = prompt(create());
      const expected = structuredClone(compiled);
      const isolated = cloneQueueEnvelope(compiled);
      expect(isolated).toEqual(expected);
      expect(isolated).not.toBe(compiled);
      expect(isolated?.output["1"]).not.toBe(compiled.output["1"]);
    },
  );

  it.each(legacyCases)(
    "preserves the accepted bootstrap copy for $name",
    ({ create }) => {
      const compiled = prompt(create());
      const expected = structuredClone(compiled.output["1"]);
      const isolated = prepare(compiled).bootstrap.output["1"];
      expect(isolated).toEqual(expected);
      expect(isolated).not.toBe(compiled.output["1"]);
    },
  );
});

describe("mixed proxy and unsupported data remains refused", () => {
  const rejectedCases = [
    { name: "function", create: () => () => undefined },
    { name: "Date", create: () => new Date("2026-01-02T03:04:05Z") },
    { name: "custom prototype", create: () => new LegacyWidgetValue(7) },
  ];
  function mixed(create: () => unknown) {
    const compiled = prompt(create());
    compiled.output["1"]!.inputs.native_region = new Proxy(
      { x: 0, y: 0, width: 64, height: 96 },
      {},
    );
    return compiled;
  }

  it.each(rejectedCases)(
    "refuses the mixed queue copy with $name",
    ({ create }) => {
      expect(cloneQueueEnvelope(mixed(create))).toBeUndefined();
    },
  );

  it.each(rejectedCases)(
    "refuses the mixed bootstrap copy with $name",
    ({ create }) => {
      expect(() => prepare(mixed(create))).toThrowError(
        "compile_failed: the Product Shell bootstrap could not be isolated from the model prompt",
      );
    },
  );
});
