import type { AppModeInputs } from "../../src/host/appModeContract";
import type { SpliceMediaIds } from "../../src/host/templateGraphTopology";
import { hostCompiledPrompt } from "./hostCompiledPrompt";
import { createQualifiedBasePrompt } from "./qualifiedBasePrompt";

export type CropPreparedTaskMode = "i2va" | "fl2va" | "l2va" | "ref2va";
export type CompiledFixtureNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

/** The crop request that Prepare canvas receives for every cropped source of the fixture. */
export const CROP_FIXTURE_REQUEST = Object.freeze({
  x: 8,
  y: 16,
  w: 320,
  h: 240,
  sourceWidth: 640,
  sourceHeight: 480,
});

/** The compiled region of CROP_FIXTURE_REQUEST, as the native crop node carries it. */
export function cropFixtureRegion(): Record<string, number> {
  return { x: 8, y: 16, width: 320, height: 240 };
}

/**
 * Put one native crop node between each loader and every consumer of its IMAGE output, as
 * Prepare canvas does. Crop node ids start at `firstCropId` and follow the loader order.
 */
export function interposeImageCrops(
  output: Record<string, CompiledFixtureNode>,
  loaders: readonly number[],
  firstCropId = 60,
): void {
  for (const [i, loader] of loaders.entries()) {
    const cropId = String(firstCropId + i);
    for (const node of Object.values(output)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        if (
          Array.isArray(value) &&
          value.length === 2 &&
          String(value[0]) === String(loader) &&
          value[1] === 0
        )
          node.inputs[name] = [cropId, 0];
      }
    }
    output[cropId] = {
      class_type: "ImageCropV2",
      inputs: { image: [String(loader), 0], crop_region: cropFixtureRegion() },
    };
  }
}

/**
 * A hermetic compiled single-clip prompt as Prepare canvas leaves it: every image source read
 * through one crop node. The supplied host proves the actual widget lowering. The envelope is in
 * the host's key order (`hostCompiledPrompt`). With `crops: false` the same prompt has no crop
 * node and the request carries no crop.
 */
export function cropPreparedCompiledPrompt(
  task_mode: CropPreparedTaskMode,
  options: Readonly<{ crops?: boolean }> = {},
) {
  const cropped = options.crops ?? true;
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
  ) as Record<string, CompiledFixtureNode>;
  const loaders = ref ? [10, 11] : task_mode === "fl2va" ? [9, 10] : [9];
  const ids: SpliceMediaIds = {
    referenceImages: ref ? loaders : [],
    referenceVideos: [],
    referenceAudios: [],
    ...(task_mode !== "l2va" && !ref ? { firstFrame: 9 } : {}),
    ...(task_mode !== "i2va" && !ref
      ? { lastFrame: task_mode === "fl2va" ? 10 : 9 }
      : {}),
    crops: cropped
      ? Object.fromEntries(
          loaders.map((loader, i) => [
            loader,
            { nodeId: 60 + i, crop: CROP_FIXTURE_REQUEST },
          ]),
        )
      : {},
  };
  if (cropped) {
    interposeImageCrops(output, loaders);
    inputs.image_crops = Object.fromEntries(
      (ref
        ? ["17", "18"]
        : task_mode === "fl2va"
          ? ["17", "18"]
          : [task_mode === "l2va" ? "18" : "17"]
      ).map((id) => [id, CROP_FIXTURE_REQUEST]),
    );
  }
  const compiled = hostCompiledPrompt(output, {});
  return { compiled, inputs, ids, output, loaders };
}
