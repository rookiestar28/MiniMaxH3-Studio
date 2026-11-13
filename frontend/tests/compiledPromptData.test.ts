import { describe, expect, it, vi } from "vitest";

import { fingerprint, snapshotGraph } from "../src/host/appModeContract";
import { cloneCompiledPromptData } from "../src/host/compiledPromptData";
import { cloneQueueEnvelope } from "../src/host/queueSeam";
import { rebindExistingContextAuthoring } from "../src/host/templateGraphTopology";
import { spliceContextPipeline } from "../src/host/templateMaterialization";
import { readQueueMetadataCompatibleGraph } from "../src/host/graphAdapter";
import { communityCanvas } from "./support/connectFixture";
import { existingManagedHostGraphFixture } from "./support/managedHostGraphFixture";

const proxy = <T extends object>(value: T): T => new Proxy(value, {});

describe("compiled prompt proxy fallback", () => {
  it("preserves JSON order, primitive values, repeated aliases and mutable isolation", () => {
    const shared = { z: [1, undefined, null, -0], a: "synthetic" };
    const source = proxy({ second: shared, first: shared, missing: undefined });
    const copied = cloneCompiledPromptData(source)!;
    expect(copied).toEqual(source);
    expect(JSON.stringify(copied)).toBe(JSON.stringify(source));
    expect(fingerprint(copied)).toBe(fingerprint(source));
    expect(Object.is(copied.first.z[3], -0)).toBe(true);
    expect(Object.hasOwn(copied, "missing")).toBe(true);
    expect(copied.first).toBe(copied.second);
    expect(copied.first).not.toBe(shared);
    copied.first.z[0] = 7;
    expect(shared.z[0]).toBe(1);
    shared.a = "changed source";
    expect(copied.first.a).toBe("synthetic");
    expect(() => structuredClone(copied)).not.toThrow();
  });

  const nonData = [
    { name: "function", create: () => () => undefined },
    { name: "symbol", create: () => Symbol("synthetic") },
    { name: "bigint", create: () => 1n },
    { name: "non-finite number", create: () => Number.NaN },
    { name: "Date", create: () => new Date(0) },
    { name: "Map", create: () => new Map([["synthetic", 1]]) },
    { name: "Set", create: () => new Set([1]) },
    { name: "typed array", create: () => new Uint8Array([1]) },
    { name: "host identity", create: () => document.createElement("div") },
    {
      name: "custom prototype",
      create: () => Object.assign(Object.create({ marker: 1 }), { value: 1 }),
    },
    { name: "sparse array", create: () => [, 1] },
  ];
  it.each(nonData)("refuses $name inside fallback data", ({ create }) => {
    expect(cloneCompiledPromptData(proxy({ value: create() }))).toBeUndefined();
  });

  it("refuses cycles without rejecting repeated acyclic aliases", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(cloneCompiledPromptData(proxy(cycle))).toBeUndefined();
    const member = { value: 1 };
    const result = cloneCompiledPromptData(proxy({ a: member, b: member }));
    expect(result?.a).toBe(result?.b);
  });

  it.each([
    "accessor",
    "toJSON",
    "hidden",
    "symbol key",
    "unsafe key",
    "array accessor",
    "array extra",
  ])(
    "refuses %s without invoking getters or toJSON in the fallback",
    (kind) => {
      const invoke = vi.fn(() => "unreadable");
      let source: object = {};
      if (kind === "accessor")
        Object.defineProperty(source, "value", {
          get: invoke,
          enumerable: true,
        });
      if (kind === "toJSON") source = { toJSON: invoke };
      if (kind === "hidden")
        Object.defineProperty(source, "value", { value: 1 });
      if (kind === "symbol key") source = { [Symbol("synthetic")]: 1 };
      if (kind === "unsafe key")
        Object.defineProperty(source, "__proto__", {
          value: {},
          enumerable: true,
        });
      if (kind === "array accessor") {
        source = [0];
        Object.defineProperty(source, "0", { get: invoke, enumerable: true });
      }
      if (kind === "array extra") source = Object.assign([0], { extra: 1 });
      expect(cloneCompiledPromptData(proxy(source))).toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it.each(["prototype", "keys", "descriptor", "revoked"])(
    "contains a %s proxy failure without exporting its error",
    (kind) => {
      const fail = () => {
        throw new Error("synthetic private exception");
      };
      const handler: ProxyHandler<object> = {};
      if (kind === "prototype") handler.getPrototypeOf = fail;
      if (kind === "keys") handler.ownKeys = fail;
      if (kind === "descriptor") handler.getOwnPropertyDescriptor = fail;
      const source = Proxy.revocable({ value: 1 }, handler);
      if (kind === "revoked") source.revoke();
      expect(cloneCompiledPromptData(source.proxy)).toBeUndefined();
    },
  );

  it("enforces the fallback depth at64 without truncation", () => {
    function nested(depth: number) {
      let value: unknown = 0;
      for (let index = 0; index < depth; index += 1) value = { value };
      return proxy(value as object);
    }
    expect(cloneCompiledPromptData(nested(64))).toEqual(nested(64));
    expect(cloneCompiledPromptData(nested(65))).toBeUndefined();
  });

  it("enforces100000 visited data members without truncation", () => {
    const accepted = proxy(Array.from({ length: 99_999 }, () => 0));
    expect(cloneCompiledPromptData(accepted)).toHaveLength(99_999);
    expect(
      cloneCompiledPromptData(proxy(Array.from({ length: 100_000 }, () => 0))),
    ).toBeUndefined();
  });
});

describe("compiled envelope and serialized snapshot boundaries", () => {
  it("does not retry a getter while copying a refused envelope's output", () => {
    const invoke = vi.fn(() => 1);
    const output = { node: { inputs: {} } };
    Object.defineProperty(output.node.inputs, "value", {
      get: invoke,
      enumerable: true,
    });
    expect(cloneQueueEnvelope(proxy({ output, workflow: {} }))).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("isolates proxy compiled output but keeps a proxy workflow refused", () => {
    const output = {
      "1": { class_type: "Synthetic", inputs: { region: proxy({ x: 1 }) } },
    };
    const source = { output, workflow: { nodes: [] } };
    const isolated = cloneQueueEnvelope(source)!;
    expect(fingerprint(isolated)).toBe(fingerprint(source));
    isolated.output["1"].inputs.region.x = 7;
    expect(output["1"].inputs.region.x).toBe(1);
    expect(
      cloneQueueEnvelope({ output, workflow: proxy({ nodes: [] }) }),
    ).toBeUndefined();
  });

  it.each(["unknown member", "output accessor", "workflow accessor"])(
    "refuses a fallback envelope with %s without invoking its getter",
    (kind) => {
      const invoke = vi.fn(() => ({}));
      const source = { output: {}, workflow: {} };
      if (kind === "unknown member") Object.assign(source, { extra: 1 });
      if (kind === "output accessor")
        Object.defineProperty(source, "output", { get: invoke });
      if (kind === "workflow accessor")
        Object.defineProperty(source, "workflow", { get: invoke });
      expect(cloneQueueEnvelope(proxy(source))).toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("does not introduce a proxy or function fallback for serialized graph snapshots", () => {
    expect(
      snapshotGraph({ nodes: [], extra: proxy({ value: 1 }) }),
    ).toBeUndefined();
    expect(
      snapshotGraph({ nodes: [], extra: { callback: () => undefined } }),
    ).toBeUndefined();
    const graph: Record<string, unknown> = { nodes: [] };
    graph.extra = graph;
    expect(() => fingerprint(snapshotGraph(graph))).toThrow(
      "graph identity is not canonically serializable",
    );
  });

  it("keeps connect and existing-authoring serialized clones strict", () => {
    const foreign = communityCanvas();
    foreign.extra = { foreignMetadata: proxy({ value: 1 }) };
    expect(() => readQueueMetadataCompatibleGraph(foreign)).not.toThrow();
    expect(() =>
      spliceContextPipeline(foreign, {
        taskMode: "t2va",
        userIntent: "Synthetic guarded connect.",
        durationSeconds: 8,
        connect: true,
      }),
    ).toThrow();
    expect(
      (foreign.nodes as unknown[]).some((node) =>
        (node as { type: string }).type.includes("H3Context"),
      ),
    ).toBe(false);
    const managed = existingManagedHostGraphFixture({
      task_mode: "t2va",
      user_intent: "Synthetic guarded authoring.",
      duration_milliseconds: 8_000,
      frame_count: 192,
    }).workflow;
    managed.extra = { foreignMetadata: proxy({ value: 1 }) };
    expect(() => readQueueMetadataCompatibleGraph(managed)).not.toThrow();
    expect(() =>
      rebindExistingContextAuthoring(managed, {
        taskMode: "t2va",
        userIntent: "Synthetic replacement intent.",
        durationSeconds: 9,
      }),
    ).toThrow();
  });
});
