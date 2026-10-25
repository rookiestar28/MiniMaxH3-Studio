import { describe, expect, it } from "vitest";
import {
  compiledPromptMatchesRequestedRoute,
  isCompatibleExistingPrompt,
} from "../src/host/appModeExistingRoute";
import type { AppModeInputs } from "../src/host/appModeContract";
import type { SpliceMediaIds } from "../src/host/templateGraphTopology";
import { createQualifiedBasePrompt } from "./support/qualifiedBasePrompt";
import {
  decodeComfyPromptHistory,
  decodeComfyPromptHistorySavedVideos,
} from "../src/host/comfyPromptHistory";

const crop = {
  x: 8,
  y: 16,
  w: 320,
  h: 240,
  sourceWidth: 640,
  sourceHeight: 480,
};
type Node = { class_type: string; inputs: Record<string, unknown> };
function fixture(task_mode: "i2va" | "fl2va" | "l2va" | "ref2va") {
  const ref = task_mode === "ref2va";
  const inputs: AppModeInputs = {
    task_mode,
    user_intent: "A kite.",
    duration_milliseconds: 5167,
    frame_count: 124,
    ...(ref
      ? { reference_image_sources: ["17", "18"] }
      : {
          ...(task_mode !== "l2va" ? { first_frame_source: "17" } : {}),
          ...(task_mode !== "i2va" ? { last_frame_source: "18" } : {}),
        }),
  };
  const image = { class_type: "LoadImage", inputs: { image: "fixture.png" } };
  const output = createQualifiedBasePrompt(
    inputs,
    ref
      ? { reference_images: [image, image] }
      : { first_frame: image, last_frame: image },
    { sharedDurationSource: true },
  ) as Record<string, Node>;
  const loaders = ref ? [10, 11] : task_mode === "fl2va" ? [9, 10] : [9];
  const ids: SpliceMediaIds = {
    referenceImages: ref ? loaders : [],
    referenceVideos: [],
    referenceAudios: [],
    ...(task_mode !== "l2va" && !ref ? { firstFrame: 9 } : {}),
    ...(task_mode !== "i2va" && !ref
      ? { lastFrame: task_mode === "fl2va" ? 10 : 9 }
      : {}),
    crops: Object.fromEntries(
      loaders.map((loader, i) => [loader, { nodeId: 60 + i, crop }]),
    ),
  };
  // Hermetic compiled shape only: the supplied host proves actual widget lowering.
  for (const [i, loader] of loaders.entries()) {
    for (const node of Object.values(output)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        if (
          Array.isArray(value) &&
          value.length === 2 &&
          String(value[0]) === String(loader) &&
          value[1] === 0
        )
          node.inputs[name] = [String(60 + i), 0];
      }
    }
    output[String(60 + i)] = {
      class_type: "ImageCropV2",
      inputs: {
        image: [String(loader), 0],
        crop_region: { x: 8, y: 16, width: 320, height: 240 },
      },
    };
  }
  inputs.image_crops = Object.fromEntries(
    (ref
      ? ["17", "18"]
      : task_mode === "fl2va"
        ? ["17", "18"]
        : [task_mode === "l2va" ? "18" : "17"]
    ).map((id) => [id, crop]),
  );
  const compiled = { output, workflow: {} };
  return { compiled, inputs, ids, output };
}
describe("crop interposer compiled identity", () => {
  it.each(["i2va", "fl2va", "l2va", "ref2va"] as const)(
    "accepts exactly bound %s crops only for preparation",
    (mode) => {
      const { compiled, inputs, ids } = fixture(mode);
      expect(isCompatibleExistingPrompt(compiled)).toBe(true);
      expect(
        compiledPromptMatchesRequestedRoute(
          compiled,
          inputs,
          "materialize",
          ids,
          undefined,
          undefined,
          true,
        ),
      ).toBe(true);
      expect(
        compiledPromptMatchesRequestedRoute(
          compiled,
          inputs,
          "materialize",
          ids,
        ),
      ).toBe(false);
    },
  );
  it.each([
    "region",
    "extra",
    "missing",
    "loader",
    "request",
    "registry",
    "native",
    "scale",
  ])("refuses a mutated %s binding", (mutation) => {
    const { compiled, inputs, ids, output } = fixture("i2va");
    if (mutation === "region")
      (output["60"]!.inputs.crop_region as Record<string, number>).width = 321;
    if (mutation === "extra") output["61"] = structuredClone(output["60"]!);
    if (mutation === "missing") delete output["60"];
    if (mutation === "loader") output["60"]!.inputs.image = ["60", 0];
    if (mutation === "request")
      inputs.image_crops = { "17": { ...crop, x: 9 } };
    if (mutation === "registry") output["11"]!.inputs.first_frame = ["9", 0];
    if (mutation === "native") output["6"]!.inputs.first_frame = ["9", 0];
    if (mutation === "scale") output["47"]!.inputs.image = ["9", 0];
    expect(
      compiledPromptMatchesRequestedRoute(
        compiled,
        inputs,
        "materialize",
        ids,
        undefined,
        undefined,
        true,
      ),
    ).toBe(false);
  });
  it("structurally refuses a second crop on the same loader", () => {
    const { compiled, output } = fixture("i2va");
    output["61"] = structuredClone(output["60"]!);
    expect(isCompatibleExistingPrompt(compiled)).toBe(false);
  });
  it("does not expand connect's reference-source admission", () => {
    expect(
      isCompatibleExistingPrompt(fixture("ref2va").compiled, "connect"),
    ).toBe(false);
  });
  it("attributes the saved video exactly when a crop preview appears in history", () => {
    const promptId = "crop-fixture-1";
    const history = {
      [promptId]: {
        status: {
          status_str: "success",
          completed: true,
          messages: [["execution_success", { prompt_id: promptId }]],
        },
        outputs: {
          "60": {
            images: [
              { filename: "crop-preview.png", subfolder: "", type: "temp" },
            ],
          },
          "43": {
            animated: [true],
            images: [
              { filename: "video.mp4", subfolder: "video", type: "output" },
            ],
          },
        },
      },
    };
    expect(decodeComfyPromptHistory(history, promptId)).toMatchObject({
      disposition: "succeeded",
      outputNodeIds: ["43", "60"],
    });
    const saved = decodeComfyPromptHistorySavedVideos(history, promptId);
    expect(saved.artifacts).toHaveLength(1);
    expect(saved.artifacts[0]).toMatchObject({ outputNodeId: "43" });
  });
});
