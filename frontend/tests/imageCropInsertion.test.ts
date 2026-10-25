import { describe, expect, it } from "vitest";
import {
  spliceContextPipeline,
  MODE_TEMPLATE,
  type Json,
} from "../src/host/templateMaterialization";
import { syntheticTemplate } from "./support/templateFixture";
import {
  IMAGE_CROP_REGION_TYPE,
  readImageCropCapability,
} from "../src/host/imageCropCapability";
import { matchesImageCropNodes } from "../src/host/imageCropBindings";

const crop = {
  x: 8,
  y: 16,
  w: 320,
  h: 240,
  sourceWidth: 640,
  sourceHeight: 480,
};
const image = {
  type: "LoadImage",
  widgetValues: ["chosen.png", "image"],
  crop,
};

describe("native crop insertion", () => {
  it.each(["i2va", "fl2va", "l2va", "ref2va"])(
    "inserts one crop per %s image before every consumer",
    (taskMode) => {
      const media =
        taskMode === "ref2va"
          ? { referenceImages: [image, image] }
          : {
              ...(taskMode !== "l2va" ? { firstFrame: image } : {}),
              ...(taskMode !== "i2va" ? { lastFrame: image } : {}),
            };
      const result = spliceContextPipeline(
        syntheticTemplate(MODE_TEMPLATE[taskMode]!),
        {
          taskMode,
          userIntent: "A red kite.",
          durationSeconds: 5.167,
          media,
        },
      );
      const nodes = result.workflow.nodes as Json[];
      const links = result.workflow.links as unknown[][];
      const crops = nodes.filter((node) => node.type === "ImageCropV2");
      const expected = taskMode === "ref2va" || taskMode === "fl2va" ? 2 : 1;
      expect(crops).toHaveLength(expected);
      expect(Object.values(result.mediaNodeIds.crops ?? {})).toHaveLength(
        expected,
      );
      for (const node of crops) {
        expect(node.inputs).toContainEqual({
          name: "crop_region",
          type: IMAGE_CROP_REGION_TYPE,
          widget: { name: "crop_region" },
          link: null,
        });
        expect(node.widgets_values).toEqual([
          { x: 8, y: 16, width: 320, height: 240 },
        ]);
        const incoming = links.filter((link) => link[3] === node.id);
        expect(incoming).toHaveLength(1);
        expect(nodes.find((entry) => entry.id === incoming[0]![1])?.type).toBe(
          "LoadImage",
        );
        expect(
          links.filter((link) => link[1] === incoming[0]![1] && link[2] === 0),
        ).toHaveLength(1);
        const consumers = links.filter((link) => link[1] === node.id);
        expect(consumers.length).toBe(taskMode === "i2va" ? 3 : 2);
        expect(result.ownedNodeIds).not.toContain(node.id);
        const loader = nodes.find((entry) => entry.id === incoming[0]![1])!;
        expect(node.pos).not.toEqual(loader.pos);
      }
    },
  );

  it("keeps crop metadata absent on an uncropped splice", () => {
    const result = spliceContextPipeline(
      syntheticTemplate(MODE_TEMPLATE.i2va!),
      {
        taskMode: "i2va",
        userIntent: "A red kite.",
        durationSeconds: 5.167,
        media: { firstFrame: { type: "LoadImage", widgetValues: [] } },
      },
    );
    expect(result.mediaNodeIds).not.toHaveProperty("crops");
  });

  it("pins compiled region equality and rejects extra, missing and wrong crops", () => {
    const ids = {
      referenceImages: [1],
      referenceVideos: [],
      referenceAudios: [],
      crops: { "1": { nodeId: 2, crop } },
    };
    const nodes = new Map([
      ["1", { class_type: "LoadImage", inputs: { image: "chosen.png" } }],
      [
        "2",
        {
          class_type: "ImageCropV2",
          inputs: {
            image: ["1", 0],
            crop_region: { x: 8, y: 16, width: 320, height: 240 },
          },
        },
      ],
    ]);
    expect(matchesImageCropNodes(ids, nodes)).toBe(true);
    const wrong = structuredClone(nodes);
    wrong.get("2")!.inputs.crop_region!.x = 9;
    expect(matchesImageCropNodes(ids, wrong)).toBe(false);
    const missing = new Map(nodes);
    missing.delete("2");
    expect(matchesImageCropNodes(ids, missing)).toBe(false);
    const extra = new Map(nodes);
    extra.set("3", nodes.get("2")!);
    expect(matchesImageCropNodes(ids, extra)).toBe(false);
  });
});

describe("native crop capability reads registered object-info data", () => {
  const definition = (
    image: unknown = ["IMAGE"],
    region: unknown = [IMAGE_CROP_REGION_TYPE, { component: "ImageCrop" }],
  ) => ({
    ImageCropV2: {
      nodeData: {
        name: "ImageCropV2",
        input: { required: { image, crop_region: region } },
      },
    },
  });
  it("accepts the native IO.BoundingBox wire type and component metadata", () =>
    expect(readImageCropCapability(definition(), true)).toBe(true));
  it("pins IO.BoundingBox's native declaration independently of the fixtures", () =>
    expect(IMAGE_CROP_REGION_TYPE).toBe("BOUNDING_BOX"));
  it.each([
    undefined,
    {},
    { ImageCrop: { nodeData: { name: "ImageCrop" } } },
    definition(["MASK"]),
    definition(["IMAGE"], ["STRING"]),
    definition(["IMAGE"], ["BOUNDINGBOX"]),
  ])("refuses missing, deprecated or wrong-shape definitions %#", (value) => {
    expect(readImageCropCapability(value, true)).toBe(false);
  });
  it("refuses definitions before registration readiness", () =>
    expect(readImageCropCapability(definition(), false)).toBe(false));
});
