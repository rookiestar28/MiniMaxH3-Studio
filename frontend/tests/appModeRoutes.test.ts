import { describe, expect, it, vi } from "vitest";
import * as contract from "../src/host/appModeContract";
import { AppModeError as DirectAppModeError } from "../src/host/appModeError";

import {
  compileDetachedCandidate,
  compileLoadedCandidate,
  resolveMaterializeRoute,
} from "../src/host/appModeRoutes";
import { preparedSequenceMediaFixture } from "./support/preparedSequenceMediaFixture";
import { sequenceTemplateFixture } from "./support/sequenceTemplateFixture";
import { nativeCanvasSequenceTemplateFixture } from "./support/nativeCanvasSequenceTemplateFixture";
import type { Json } from "../src/host/templateGraphTopology";

describe("retained sequence materialization route", () => {
  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["l2va", "l2va"],
    ["fl2va", "fl2va"],
    ["t2va", "fl2va"],
  ] as const)(
    "materializes retained child %s of %s without querying the previous canvas",
    async (task, global) => {
      const { inputs, prepared } = preparedSequenceMediaFixture(
        task,
        global,
        false,
      );
      const options = {
        signal: undefined,
        artifactScope: undefined,
        preparedCanonicalPrompt: undefined,
        loadTemplate: vi.fn(async (name: string) =>
          nativeCanvasSequenceTemplateFixture(name),
        ),
        readNodeDefinitions: () => undefined,
        nodeDefinitionReadinessReached: () => false,
        admitted: { status: "admitted" as const },
        preparedSequenceMedia: prepared,
      };
      const result = await resolveMaterializeRoute(
        { nodes: [], links: [] },
        inputs,
        options,
      );
      const nodes = (result.candidateWorkflow as Json).nodes as Json[];
      expect(
        nodes
          .filter((node) => node.type === "LoadImage")
          .map((node) => (node.widgets_values as unknown[])[0])
          .sort(),
      ).toEqual(
        (prepared.bindings?.entries ?? []).map((row) => row.locator).sort(),
      );
      expect(
        nodes.filter((node) => node.type === "MiniMaxH3AddGuide"),
      ).toHaveLength(task === "l2va" || task === "fl2va" ? 1 : 0);
      expect(
        nodes.some((node) => node.type === "ImageScaleToTotalPixels"),
      ).toBe(global === "i2va");
      if (task === "t2va" && global === "i2va")
        expect(result.materializedMedia.geometryDonor).toBeDefined();
    },
  );
});

describe("App Mode candidate compilation routes", () => {
  it("compiles the loaded root without substituting a detached graph", async () => {
    const compiled = { output: {}, workflow: { id: "loaded" } };
    const graphToPrompt = vi.fn(() => compiled);
    await expect(compileLoadedCandidate({ graphToPrompt })).resolves.toBe(
      compiled,
    );
    expect(graphToPrompt).toHaveBeenCalledWith();
  });

  it("snapshots a detached candidate before compiling it", async () => {
    const serialized = { nodes: [{ id: 1 }], links: [] };
    const detached = { id: "detached" };
    const createDetachedGraph = vi.fn((_candidate: unknown) => detached);
    const graphToPrompt = vi.fn((graph?: unknown) => ({
      output: {},
      workflow: graph,
    }));
    const result = await compileDetachedCandidate(
      { graphToPrompt },
      createDetachedGraph,
      serialized,
    );
    expect(createDetachedGraph).toHaveBeenCalledOnce();
    expect(createDetachedGraph.mock.calls[0]?.[0]).toEqual(serialized);
    expect(createDetachedGraph.mock.calls[0]?.[0]).not.toBe(serialized);
    expect(graphToPrompt).toHaveBeenCalledWith(detached);
    expect(result.workflow).toBe(detached);
  });
});

describe("closed compile diagnostic origin", () => {
  it("preserves the error class identity through the contract facade", () => {
    expect(contract.AppModeError).toBe(DirectAppModeError);
    const direct = new DirectAppModeError(
      "compile_failed",
      "synthetic refusal",
    );
    const facade = new contract.AppModeError(
      "compile_failed",
      "synthetic refusal",
    );
    expect(direct).toBeInstanceOf(contract.AppModeError);
    expect(facade).toBeInstanceOf(DirectAppModeError);
  });

  it("tags materialized identity failure before a host write", async () => {
    const { inputs, prepared } = preparedSequenceMediaFixture(
      "i2va",
      "i2va",
      false,
    );
    const template = sequenceTemplateFixture("i2va");
    const identity = vi
      .spyOn(contract, "graphFingerprint")
      .mockImplementationOnce(() => {
        throw new Error("synthetic materialized identity refusal");
      });
    try {
      await expect(
        resolveMaterializeRoute({ nodes: [], links: [] }, inputs, {
          signal: undefined,
          artifactScope: undefined,
          preparedCanonicalPrompt: undefined,
          loadTemplate: async () => template,
          readNodeDefinitions: () => undefined,
          nodeDefinitionReadinessReached: () => false,
          admitted: { status: "admitted" },
          preparedSequenceMedia: prepared,
        }),
      ).rejects.toMatchObject({
        code: "compile_failed",
        compileStep: "materialized_identity",
        message:
          "compile_failed: the qualified Base graph candidate has no stable identity",
      });
    } finally {
      identity.mockRestore();
    }
  });

  it("tags the loaded compiler failure without changing its message", async () => {
    await expect(
      compileLoadedCandidate({
        graphToPrompt: async () => {
          throw new Error("synthetic loaded compiler refusal");
        },
      }),
    ).rejects.toMatchObject({
      code: "compile_failed",
      compileStep: "loaded_compile",
      message: "compile_failed: the host could not compile the loaded H3 graph",
    });
  });

  it("leaves the excluded detached compiler error untagged", async () => {
    const failure: unknown = await compileDetachedCandidate(
      {
        graphToPrompt: async () => {
          throw new Error("synthetic detached compiler refusal");
        },
      },
      (value) => value,
      { nodes: [], links: [] },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "compile_failed" });
    expect(Object.hasOwn(failure as object, "compileStep")).toBe(false);
  });

  it.each([
    "materialized_identity",
    "root_write",
    "root_write_bootstrap",
    "loaded_compile",
    "post_compile_check",
    "compiled_admission",
    "compiled_fingerprint",
  ])("freezes the closed own diagnostic %s without serializing it", (step) => {
    const error = Reflect.construct(contract.AppModeError, [
      "compile_failed",
      "synthetic refusal",
      undefined,
      step,
    ]) as Error;
    expect(Object.getOwnPropertyDescriptor(error, "compileStep")).toEqual({
      value: step,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(error.message).toBe("compile_failed: synthetic refusal");
    expect(JSON.stringify(error)).not.toContain(step);
    expect(JSON.stringify(error)).not.toContain("compileStep");
  });

  it("preserves untagged reasons, messages and error mutability", () => {
    const reason = { kind: "queue_response_invalid" as const };
    const error = new contract.AppModeError(
      "queue_failed",
      "synthetic response",
      reason,
    );
    expect(error).toMatchObject({
      code: "queue_failed",
      message: "queue_failed: synthetic response",
      reason,
      source: "queue",
      recovery: "use_native",
    });
    expect(Object.isFrozen(error.reason)).toBe(true);
    expect(Object.isFrozen(error)).toBe(false);
    expect(Object.hasOwn(error, "compileStep")).toBe(false);
  });

  it("keeps the existing reason separate from a diagnostic origin", () => {
    const reason = { kind: "template_unavailable" as const };
    const error = new contract.AppModeError(
      "compile_failed",
      "synthetic refusal",
      reason,
      "materialized_identity",
    );
    expect(error).toMatchObject({
      message: "compile_failed: synthetic refusal",
      reason,
      source: "compile",
      recovery: "retry",
      compileStep: "materialized_identity",
    });
    expect(Object.isFrozen(error.reason)).toBe(true);
    expect(JSON.stringify(error)).not.toContain("compileStep");
  });

  it.each([
    ["compile_failed", "unknown_step"],
    ["queue_failed", "compiled_admission"],
  ])("does not attach a diagnostic for code=%s value=%s", (code, step) => {
    const error = Reflect.construct(contract.AppModeError, [
      code,
      "synthetic refusal",
      undefined,
      step,
    ]) as Error;
    expect(Object.hasOwn(error, "compileStep")).toBe(false);
  });
});

describe("closed compile admission selection", () => {
  it.each(["envelope", "compatibility", "requested_route"])(
    "attaches only the closed own admission value %s",
    (value) => {
      const error = Reflect.construct(DirectAppModeError, [
        "compile_failed",
        "synthetic refusal",
        undefined,
        "compiled_admission",
        value,
      ]) as Error;
      expect(error).toBeInstanceOf(contract.AppModeError);
      expect(
        Object.getOwnPropertyDescriptor(error, "compileAdmission"),
      ).toEqual({
        value,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      expect(Object.isFrozen(error)).toBe(true);
      expect(error.message).toBe("compile_failed: synthetic refusal");
      expect(JSON.stringify(error)).not.toContain("compileAdmission");
      expect(Object.keys(error)).not.toContain("compileAdmission");
    },
  );

  it.each([
    ["materialized_identity", "envelope"],
    ["root_write", "envelope"],
    ["root_write_bootstrap", "envelope"],
    ["loaded_compile", "envelope"],
    ["post_compile_check", "envelope"],
    ["compiled_fingerprint", "envelope"],
    ["compiled_admission", undefined],
    ["compiled_admission", "unknown"],
    ["compiled_admission", { kind: "envelope", detail: "synthetic" }],
    ["compiled_admission", "envelope:synthetic-detail"],
    [undefined, "envelope"],
  ])("keeps the detail absent for step=%s value=%s", (step, value) => {
    const error = Reflect.construct(DirectAppModeError, [
      "compile_failed",
      "synthetic refusal",
      undefined,
      step,
      value,
    ]) as Error;
    expect(Object.hasOwn(error, "compileAdmission")).toBe(false);
  });

  it.each([
    "incompatible_seam",
    "incompatible_graph",
    "dirty_graph",
    "invalid_request",
    "reference_capacity_exceeded",
    "queue_failed",
    "sequence_media_changed",
    "sequence_media_unavailable",
    "execution_failed",
    "execution_interrupted",
    "ambiguous_host_ownership",
    "cancelled",
    "stale_graph",
    "rollback_failed",
  ])("keeps the detail absent for code=%s", (code) => {
    const error = Reflect.construct(DirectAppModeError, [
      code,
      "synthetic refusal",
      undefined,
      "compiled_admission",
      "envelope",
    ]) as Error;
    expect(Object.hasOwn(error, "compileAdmission")).toBe(false);
    expect(Object.hasOwn(error, "compileStep")).toBe(false);
    expect(Object.isFrozen(error)).toBe(false);
  });
});
