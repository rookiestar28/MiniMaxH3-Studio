import { afterEach, describe, expect, it, vi } from "vitest";
import * as canvasOwnedWrite from "../src/host/canvasOwnedWrite";

import {
  compiledOutputNodes,
  isSafeCompiledNodeEnvelope,
} from "../src/host/appModeContract";
import { createAppModeController } from "../src/host/appMode";
import { isCompatibleExistingPrompt } from "../src/host/appModeExistingRoute";
import { isSafeCompiledMetadata } from "../src/host/compiledMetadata";
import { createQualifiedBasePrompt } from "./support/qualifiedBasePrompt";
import { withCompiledPackIdentity } from "./support/compiledMetadataFixture";
import { fixtureBackedAppModeHost } from "./support/hostSeamTestDouble";
import { loadAvailableProfile } from "./support/generationProfileFixture";
import { loadSyntheticTemplate } from "./support/templateFixture";

afterEach(() => vi.restoreAllMocks());

function compiledWithPackIdentity() {
  const output = createQualifiedBasePrompt({
    task_mode: "t2va",
    user_intent: "safe",
    duration_milliseconds: 5167,
    frame_count: 124,
  }) as Record<string, Record<string, unknown>>;
  return withCompiledPackIdentity({ output, workflow: {} });
}

describe("compiled host pack metadata", () => {
  it("admits the new host shape through compiledOutputNodes", () => {
    const compiled = compiledWithPackIdentity();
    expect(compiledOutputNodes(compiled).length).toBe(
      Object.keys(compiled.output).length,
    );
  });

  it("admits the new host shape through isCompatibleExistingPrompt", () => {
    expect(isCompatibleExistingPrompt(compiledWithPackIdentity())).toBe(true);
  });

  it("keeps old shapes and the exact UTF-16 boundary", () => {
    for (const _meta of [
      undefined,
      {},
      { title: "Node" },
      { title: "x".repeat(256) },
      { cnr_id: "", aux_id: "", ver: "" },
      { ver: "\u{1f600}".repeat(128) },
    ]) {
      expect(
        isSafeCompiledNodeEnvelope({
          class_type: "Node",
          inputs: {},
          ...(_meta === undefined ? {} : { _meta }),
        }),
      ).toBe(true);
    }
  });

  it.each([
    ["257 units", { title: "x".repeat(257) }],
    ["10000 units", { title: "x".repeat(10000) }],
    ["undefined", { title: undefined }],
  ] as const)("keeps base title compatibility for %s", (_label, _meta) => {
    expect(isSafeCompiledMetadata(_meta)).toBe(true);
    expect(
      isSafeCompiledNodeEnvelope({ class_type: "Node", inputs: {}, _meta }),
    ).toBe(true);
  });

  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ["unknown", { title: "Node", undisclosed: "private-value" }],
    ...["__proto__", "prototype", "constructor"].map(
      (key): readonly [string, unknown] => [
        "prototype-sensitive",
        JSON.parse(`{"${key}":"private-value"}`),
      ],
    ),
    ["non-string title", { title: 1 }],
    ...["cnr_id", "aux_id", "ver"].flatMap(
      (key): ReadonlyArray<readonly [string, unknown]> => [
        ["non-string", { [key]: 1 }],
        ["undefined member", { [key]: undefined }],
        ["oversize", { [key]: "x".repeat(257) }],
      ],
    ),
    ["array", []],
    ["null", null],
    ["scalar", "private-value"],
  ] as const;

  it.each(refused)(
    "refuses metadata class %s without revealing content",
    async (_label, _meta) => {
      // Observe the private restoreOwnedGraph closure at its rollback effect boundary.
      const restoreOwnedGraph = vi.spyOn(canvasOwnedWrite, "restoreGraph");
      const compiled = compiledWithPackIdentity();
      compiled.output["1"]!._meta = _meta;
      expect(compiledOutputNodes(compiled).length).toBe(0);
      expect(isCompatibleExistingPrompt(compiled)).toBe(false);
      const queuePrompt = vi.fn();
      let visibleGraph: unknown = { nodes: [], links: [] };
      const { app, api } = fixtureBackedAppModeHost(
        {
          loadApiJson: vi.fn(),
          loadGraphData: vi.fn((workflow: unknown) => {
            visibleGraph = structuredClone(workflow);
          }),
          graphToPrompt: vi.fn().mockResolvedValue(compiled),
          graph: { serialize: () => visibleGraph },
        },
        { queuePrompt },
      );
      const failure = await createAppModeController(app, api, {
        loadTemplate: (name) => ({
          ...loadSyntheticTemplate(name),
          id: "compiled-metadata-root",
        }),
        loadProfile: loadAvailableProfile,
      })
        .start({
          task_mode: "t2va",
          user_intent: "safe",
          duration_milliseconds: 5167,
          frame_count: 124,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(
        failure instanceof Error &&
          failure.message ===
            "compile_failed: an unrecognized compiled _meta member",
      ).toBe(true);
      expect(queuePrompt).not.toHaveBeenCalled();
      expect(restoreOwnedGraph).toHaveBeenCalledOnce();
    },
  );

  it("keeps extra top-level members outside the envelope", () => {
    expect(
      isSafeCompiledNodeEnvelope({
        class_type: "Node",
        inputs: {},
        _meta: { ver: "1" },
        extra: true,
      }),
    ).toBe(false);
  });
});
