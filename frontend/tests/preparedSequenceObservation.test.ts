import { describe, expect, it, vi } from "vitest";
import { observePreparedSequenceMedia } from "../src/host/preparedSequenceObservation";
import {
  applyPreparedSequenceCrops,
  resolvePreparedSequenceSpliceMedia,
} from "../src/host/preparedSequenceMedia";
import { applySequenceClosingGuide } from "../src/host/sequenceFrameMaterialization";
import { sequenceMediaBindingFingerprint } from "../src/host/sequenceMediaBindings";
import {
  spliceContextPipeline,
  type Json,
} from "../src/host/templateMaterialization";
import type {
  AppModeCompiledPrompt,
  AppModeInputs,
} from "../src/host/appModeContract";
import { preparedSequenceMediaFixture } from "./support/preparedSequenceMediaFixture";
import { sequenceTemplateFixture } from "./support/sequenceTemplateFixture";
import { matchesPreparedSequenceMedia } from "../src/host/preparedSequenceAdmission";
import { createPreparedSequenceGraphGuard } from "../src/host/preparedSequenceGraph";

function fixture(
  task: AppModeInputs["task_mode"] = "i2va",
  global: "i2va" | "fl2va" | "l2va" = "i2va",
  cropped = true,
) {
  const { inputs, prepared } = preparedSequenceMediaFixture(
    task,
    global,
    cropped,
  );
  if (task === "ref2va") throw new Error("unsupported fixture mode");
  const template = sequenceTemplateFixture(task);
  let result = spliceContextPipeline(template, {
    taskMode: task,
    sequenceTaskMode: global,
    userIntent: inputs.user_intent,
    durationSeconds: 6,
    media: resolvePreparedSequenceSpliceMedia(inputs, prepared),
  });
  result = applyPreparedSequenceCrops(result, inputs, prepared);
  if (task === "l2va" || task === "fl2va")
    result = applySequenceClosingGuide(result, 6);
  // Hermetic serialization double: actual edges from the production splice, pinned native widget names.
  const output = Object.fromEntries(
    (result.workflow.nodes as Json[]).map((node) => {
      const nodeInputs: Record<string, unknown> = {};
      for (const port of (node.inputs ?? []) as Json[]) {
        const edge = (result.workflow.links as unknown[][]).find(
          (edge) => edge[0] === port.link,
        );
        if (edge) nodeInputs[String(port.name)] = [String(edge[1]), edge[2]];
      }
      const widgets = node.widgets_values as unknown[] | undefined;
      const names =
        node.type === "LoadImage"
          ? ["image"]
          : node.type === "ImageCropV2"
            ? ["crop_region"]
            : node.type === "ImageScaleToTotalPixels"
              ? ["upscale_method", "megapixels", "resolution_steps"]
              : node.type === "MiniMaxH3AddGuide"
                ? ["frame_idx"]
                : [];
      names.forEach((name, index) => {
        nodeInputs[name] = widgets?.[index];
      });
      return [String(node.id), { class_type: node.type, inputs: nodeInputs }];
    }),
  );
  return {
    inputs,
    prepared,
    result,
    compiled: { output, workflow: {} } as AppModeCompiledPrompt,
  };
}

const observer = (prepared: ReturnType<typeof fixture>["prepared"]) =>
  vi.fn(async (request: { locator: string }) => {
    const entry = prepared.bindings!.entries.find(
      (row) => row.locator === request.locator,
    )!;
    return {
      ...entry.source_identity,
      receipt_handle:
        "ig_" + "n".repeat(40) + (entry.role === "first_frame" ? "f" : "l"),
    };
  });

describe("fresh owned-child sequence media observation", () => {
  it("accepts distinct content-equal serializations and detects an in-place retained-reference edit", () => {
    const { inputs, result } = fixture();
    const retained = result.workflow;
    const guard = createPreparedSequenceGraphGuard(
      retained,
      result.anchorNodeId,
      result.mediaNodeIds,
      inputs,
    );
    const fresh = structuredClone(retained);
    expect(fresh).not.toBe(retained);
    expect(() => guard(fresh)).not.toThrow();
    const crop = (retained.nodes as Json[]).find(
      (node) => node.type === "ImageCropV2",
    )!;
    (crop.widgets_values as Json[])[0]!.x = 17;
    expect(() => guard(retained)).toThrow(
      expect.objectContaining({ code: "sequence_media_changed" }),
    );
  });

  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["l2va", "l2va"],
    ["fl2va", "fl2va"],
    ["t2va", "fl2va"],
  ] as const)(
    "admits exact private compiled child %s of %s",
    (task, global) => {
      const { inputs, prepared, result, compiled } = fixture(task, global);
      expect(
        matchesPreparedSequenceMedia(
          compiled,
          result.mediaNodeIds,
          inputs,
          prepared,
        ),
      ).toBe(true);
    },
  );

  it.each([
    "extra_loader",
    "crop_region",
    "crop_bypass",
    "source",
    "guide_extra",
    "registry",
    "geometry",
  ])("refuses private compiled %s drift", (defect) => {
    const closing = defect === "guide_extra";
    const { inputs, prepared, result, compiled } = fixture(
      closing ? "l2va" : "i2va",
      closing ? "l2va" : "i2va",
    );
    const output = compiled.output as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    const find = (type: string) =>
      Object.values(output).find((node) => node.class_type === type)!;
    if (defect === "extra_loader")
      output.extra = {
        class_type: "LoadImage",
        inputs: { image: "synthetic/foreign.png" },
      };
    if (defect === "crop_region")
      (find("ImageCropV2").inputs.crop_region as Json).foreign = true;
    if (defect === "crop_bypass")
      output.extra = {
        class_type: "PreviewImage",
        inputs: { images: [String(result.mediaNodeIds.firstFrame), 0] },
      };
    if (defect === "source")
      find("LoadImage").inputs.image = "synthetic/foreign.png";
    if (defect === "guide_extra")
      find("MiniMaxH3AddGuide").inputs.foreign = true;
    if (defect === "registry")
      find("comfyui_h3_context.H3Context.ReferenceRegistry").inputs.last_frame =
        find(
          "comfyui_h3_context.H3Context.ReferenceRegistry",
        ).inputs.first_frame;
    if (defect === "geometry")
      find("ImageScaleToTotalPixels").inputs.megapixels = 0.4;
    expect(
      matchesPreparedSequenceMedia(
        compiled,
        result.mediaNodeIds,
        inputs,
        prepared,
      ),
    ).toBe(false);
  });

  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["l2va", "l2va"],
    ["fl2va", "fl2va"],
    ["t2va", "fl2va"],
  ] as const)(
    "renews child %s of %s against exact retained semantics after loader remapping",
    async (task, global) => {
      const { inputs, prepared, result, compiled } = fixture(task, global);
      const observe = observer(prepared);
      const value = await observePreparedSequenceMedia(
        result.workflow,
        compiled,
        result.mediaNodeIds,
        inputs,
        prepared,
        observe,
        { anchorNodeId: result.anchorNodeId, readGraph: () => result.workflow },
      );
      expect(observe).toHaveBeenCalledTimes(
        prepared.bindings?.entries.length ?? 0,
      );
      expect(value.media_binding_fingerprint).toBe(
        prepared.bindings === null
          ? null
          : sequenceMediaBindingFingerprint(prepared.bindings),
      );
      expect(value.source_identities.map((row) => row.asset_id)).toEqual(
        prepared.bindings?.entries.map((row) => row.asset_id) ?? [],
      );
      for (const row of value.source_identities) {
        expect(Object.keys(row).sort()).toEqual([
          "asset_id",
          "receipt_handle",
          "role",
          "source_fingerprint",
        ]);
        expect(row.receipt_handle).not.toBe(
          prepared.bindings!.entries.find(
            (entry) => entry.asset_id === row.asset_id,
          )!.source_identity.receipt_handle,
        );
      }
      expect(JSON.stringify(value)).not.toMatch(
        /locator|crop_region|retainedCrops|synthetic\//,
      );
    },
  );

  it.each([
    "crop",
    "loader",
    "source",
    "native_first",
    "geometry",
    "guide_index",
    "guide_last",
  ])("refuses changed %s before observing any source", async (defect) => {
    const closing = defect.startsWith("guide");
    const { inputs, prepared, result, compiled } = fixture(
      closing ? "l2va" : "i2va",
      closing ? "l2va" : "i2va",
    );
    const output = compiled.output as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    const find = (type: string) =>
      Object.values(output).find((node) => node.class_type === type)!;
    if (defect === "crop")
      (find("ImageCropV2").inputs.crop_region as Json).x = 17;
    if (defect === "loader")
      delete output[String(result.mediaNodeIds.firstFrame)];
    if (defect === "source")
      find("LoadImage").inputs.image = "synthetic/other.png";
    if (defect === "native_first")
      find("MiniMaxH3ImageToVideo").inputs.first_frame = ["unrelated", 0];
    if (defect === "geometry")
      find("ImageScaleToTotalPixels").inputs.megapixels = 0.4;
    if (defect === "guide_index")
      find("MiniMaxH3AddGuide").inputs.frame_idx = 157;
    if (defect === "guide_last")
      find("MiniMaxH3ImageToVideo").inputs.last_frame =
        find("MiniMaxH3AddGuide").inputs.image;
    const observe = observer(prepared);
    await expect(
      observePreparedSequenceMedia(
        result.workflow,
        compiled,
        result.mediaNodeIds,
        inputs,
        prepared,
        observe,
      ),
    ).rejects.toThrow(/sequence_media_(changed|unavailable)/);
    expect(observe).not.toHaveBeenCalled();
  });

  it("refuses a changed file fingerprint instead of reusing the spent Start receipt", async () => {
    const { inputs, prepared, result, compiled } = fixture();
    const observe = vi.fn(async () => ({
      ...prepared.bindings!.entries[0]!.source_identity,
      receipt_handle: "ig_" + "n".repeat(40),
      source_fingerprint: "sha256:" + "f".repeat(64),
    }));
    await expect(
      observePreparedSequenceMedia(
        result.workflow,
        compiled,
        result.mediaNodeIds,
        inputs,
        prepared,
        observe,
      ),
    ).rejects.toThrow("sequence_media_changed");
    expect(observe).toHaveBeenCalledOnce();
  });

  it.each(["source", "crop", "geometry", "guide_index", "guide_port"])(
    "refuses visible %s drift during fresh receipt observation",
    async (defect) => {
      const closing = defect.startsWith("guide");
      const { inputs, prepared, result, compiled } = fixture(
        closing ? "l2va" : "i2va",
        closing ? "l2va" : "i2va",
      );
      const renew = observer(prepared);
      const observe = vi.fn(async (request: { locator: string }) => {
        const receipt = await renew(request);
        const nodes = result.workflow.nodes as Json[];
        if (defect === "source")
          (
            nodes.find((node) => node.type === "LoadImage")!
              .widgets_values as unknown[]
          )[0] = "synthetic/changed.png";
        if (defect === "crop")
          (
            nodes.find((node) => node.type === "ImageCropV2")!
              .widgets_values as Json[]
          )[0]!.x = 17;
        if (defect === "geometry")
          (
            nodes.find((node) => node.type === "ImageScaleToTotalPixels")!
              .widgets_values as unknown[]
          )[1] = 0.4;
        if (defect === "guide_index")
          (
            nodes.find((node) => node.type === "MiniMaxH3AddGuide")!
              .widgets_values as unknown[]
          )[0] = 157;
        if (defect === "guide_port")
          (
            nodes.find((node) => node.type === "MiniMaxH3AddGuide")!
              .inputs as Json[]
          ).find((port) => port.name === "image")!.link = null;
        return receipt;
      });
      await expect(
        observePreparedSequenceMedia(
          result.workflow,
          compiled,
          result.mediaNodeIds,
          inputs,
          prepared,
          observe,
          {
            anchorNodeId: result.anchorNodeId,
            readGraph: () => result.workflow,
          },
        ),
      ).rejects.toThrow("sequence_media_changed");
      expect(observe).toHaveBeenCalledOnce();
    },
  );

  it("refuses a visible guide edit hidden by an older compiled prompt before observing", async () => {
    const { inputs, prepared, result, compiled } = fixture("l2va", "l2va");
    (
      (result.workflow.nodes as Json[]).find(
        (node) => node.type === "MiniMaxH3AddGuide",
      )!.widgets_values as unknown[]
    )[0] = 157;
    const observe = observer(prepared);
    await expect(
      observePreparedSequenceMedia(
        result.workflow,
        compiled,
        result.mediaNodeIds,
        inputs,
        prepared,
        observe,
        { anchorNodeId: result.anchorNodeId, readGraph: () => result.workflow },
      ),
    ).rejects.toThrow("sequence_media_changed");
    expect(observe).not.toHaveBeenCalled();
  });
});
