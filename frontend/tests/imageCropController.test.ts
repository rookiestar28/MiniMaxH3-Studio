import { describe, expect, it, vi } from "vitest";
import {
  createAppModeController,
  type AppModeInputs,
} from "../src/host/appMode";
import { fixtureBackedAppModeHost } from "./support/hostSeamTestDouble";
import { loadAvailableProfile } from "./support/generationProfileFixture";
import { loadSyntheticTemplate } from "./support/templateFixture";
import { IMAGE_CROP_REGION_TYPE } from "../src/host/imageCropCapability";

const crop = {
  x: 8,
  y: 16,
  w: 320,
  h: 240,
  sourceWidth: 640,
  sourceHeight: 480,
};
const inputs: AppModeInputs = {
  task_mode: "i2va",
  user_intent: "A kite.",
  duration_milliseconds: 5167,
  frame_count: 124,
  first_frame_source: "17",
  image_crops: { "17": crop },
};
function setup() {
  let locator = "fixture.png";
  let width = 640;
  let changeDuringMeasure = false;
  let definitions: unknown = {
    crop: {
      nodeData: {
        name: "ImageCropV2",
        input: {
          required: { image: ["IMAGE"], crop_region: [IMAGE_CROP_REGION_TYPE] },
        },
      },
    },
  };
  const readNodeDefinitions = vi.fn(() => definitions);
  const loadGraphData = vi.fn();
  const queuePrompt = vi.fn();
  const { app, api } = fixtureBackedAppModeHost(
    {
      loadApiJson: vi.fn(),
      loadGraphData,
      graph: {
        serialize: () => ({
          nodes: [
            {
              id: 17,
              type: "LoadImage",
              inputs: [],
              outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
              widgets_values: [locator, "image"],
            },
          ],
          links: [],
        }),
      },
      graphToPrompt: vi.fn(() => ({
        output: {
          "17": { class_type: "LoadImage", inputs: { image: locator } },
        },
        workflow: {},
      })),
    },
    { queuePrompt, fileURL: (path: string) => path },
  );
  const measureSourceImage = vi.fn(async () => {
    if (changeDuringMeasure) locator = "changed-during-measure.png";
    return { width, height: 480 };
  });
  const controller = createAppModeController(app, api, {
    loadTemplate: loadSyntheticTemplate,
    loadProfile: loadAvailableProfile,
    readNodeDefinitions,
    measureSourceImage,
  });
  return {
    controller,
    loadGraphData,
    queuePrompt,
    readNodeDefinitions,
    measureSourceImage,
    changeFile() {
      locator = "changed.png";
    },
    changeSize() {
      width = 800;
    },
    changeDuringMeasure() {
      changeDuringMeasure = true;
    },
    removeCropCapability() {
      definitions = {};
    },
  };
}
describe("crop validation is inside execute before the first canvas write", () => {
  it.each(["file", "size", "during measure"])(
    "refuses stale %s with zero writes or queue operations",
    async (mutation) => {
      const row = setup();
      await row.controller.cropSources.open("17");
      row.controller.cropSources.apply("17", crop);
      if (mutation === "file") row.changeFile();
      if (mutation === "size") row.changeSize();
      if (mutation === "during measure") row.changeDuringMeasure();
      await expect(
        row.controller.prepareCanvas(inputs, { replaceExisting: true }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        reason: { kind: "image_crop_stale" },
      });
      expect(row.loadGraphData).not.toHaveBeenCalled();
      expect(row.queuePrompt).not.toHaveBeenCalled();
    },
  );
  it("rechecks native capability from the materializer's one definition read", async () => {
    const row = setup();
    await row.controller.cropSources.open("17");
    row.controller.cropSources.apply("17", crop);
    expect(row.controller.cropAvailable()).toBe(true);
    row.removeCropCapability();
    row.readNodeDefinitions.mockClear();
    await expect(
      row.controller.prepareCanvas(inputs, { replaceExisting: true }),
    ).rejects.toMatchObject({
      code: "incompatible_seam",
      reason: { kind: "image_crop_unavailable" },
    });
    expect(row.readNodeDefinitions).toHaveBeenCalledOnce();
    expect(row.loadGraphData).not.toHaveBeenCalled();
    expect(row.queuePrompt).not.toHaveBeenCalled();
  });
  it("refuses crop-bearing non-preparation starts before source measurement", async () => {
    const row = setup();
    await expect(
      row.controller.start(inputs, { replaceExisting: true }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      reason: { kind: "image_crop_invalid" },
    });
    expect(row.measureSourceImage).not.toHaveBeenCalled();
    expect(row.loadGraphData).not.toHaveBeenCalled();
    expect(row.queuePrompt).not.toHaveBeenCalled();
  });
});
