import { describe, expect, it, vi } from "vitest";
import { observePreparedSequenceMedia } from "../../src/host/preparedSequenceObservation";
import {
  applyPreparedSequenceCrops,
  resolvePreparedSequenceSpliceMedia,
} from "../../src/host/preparedSequenceMedia";
import { applySequenceClosingGuide } from "../../src/host/sequenceFrameMaterialization";
import { sequenceMediaBindingFingerprint } from "../../src/host/sequenceMediaBindings";
import {
  spliceContextPipeline,
  type Json,
} from "../../src/host/templateMaterialization";
import type {
  AppModeCompiledPrompt,
  AppModeInputs,
} from "../../src/host/appModeContract";
import { preparedSequenceMediaFixture } from "./preparedSequenceMediaFixture";
import { sequenceTemplateFixture } from "./sequenceTemplateFixture";
import { matchesPreparedSequenceMedia } from "../../src/host/preparedSequenceAdmission";
import { createPreparedSequenceGraphGuard } from "../../src/host/preparedSequenceGraph";

export function sequenceFailureFixture(
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

export const sequenceFailureObserver = (
  prepared: ReturnType<typeof sequenceFailureFixture>["prepared"],
) =>
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
