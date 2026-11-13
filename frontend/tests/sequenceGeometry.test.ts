import { describe, expect, it } from "vitest";
import {
  spliceContextPipeline,
  type Json,
} from "../src/host/templateMaterialization";
import { validateSerializedLinks } from "../src/host/graphAdapter";
import { syntheticTemplate } from "./support/templateFixture";

const source = {
  type: "LoadImage",
  widgetValues: ["synthetic/sequence-donor.png", "image"],
};
const base = { userIntent: "synthetic sequence shot", durationSeconds: 6 };
const graphNodes = (graph: Json) => graph.nodes as Json[];
const origin = (graph: Json, target: Json, name: string) => {
  const port = (target.inputs as Json[]).find((row) => row.name === name)!;
  return (graph.links as unknown[][])
    .find((edge) => edge[0] === port.link)
    ?.slice(1, 3);
};

describe("global sequence geometry follows single-clip mode", () => {
  it("gives an I2VA middle T2VA child an owned geometry-only donor", () => {
    const template = syntheticTemplate("video_minimax_h3_t2v");
    const before = structuredClone(template);
    const result = spliceContextPipeline(template, {
      ...base,
      taskMode: "t2va",
      sequenceTaskMode: "i2va",
      media: { geometryDonor: source },
    });
    const nodes = graphNodes(result.workflow);
    const anchor = nodes.find((node) => node.id === result.anchorNodeId)!;
    const loader = nodes.find((node) => node.type === "LoadImage")!;
    const scale = nodes.find(
      (node) => node.type === "ImageScaleToTotalPixels",
    )!;
    const size = nodes.find((node) => node.type === "GetImageSize")!;
    expect(loader).toBeDefined();
    expect(result.mediaNodeIds.geometryDonor).toBe(loader.id);
    expect(loader.widgets_values).toEqual(source.widgetValues);
    expect(origin(result.workflow, anchor, "first_frame")).toBeUndefined();
    expect(origin(result.workflow, anchor, "last_frame")).toBeUndefined();
    expect(
      nodes.some((node) => String(node.type).endsWith(".ReferenceRegistry")),
    ).toBe(false);
    expect(origin(result.workflow, scale, "image")).toEqual([loader.id, 0]);
    expect(origin(result.workflow, size, "image")).toEqual([scale.id, 0]);
    expect(origin(result.workflow, anchor, "width")).toEqual([size.id, 0]);
    expect(origin(result.workflow, anchor, "height")).toEqual([size.id, 1]);
    expect(scale.widgets_values).toEqual(["nearest-exact", 0.8, 32]);
    expect(validateSerializedLinks(result.workflow, nodes)).toBeUndefined();
    expect(template).toEqual(before);
  });

  it.each(["fl2va", "l2va"])(
    "keeps template geometry for a %s frame child",
    (sequenceTaskMode) => {
      const taskMode = sequenceTaskMode === "fl2va" ? "i2va" : "l2va";
      const result = spliceContextPipeline(
        syntheticTemplate("video_minimax_h3_i2v"),
        {
          ...base,
          taskMode,
          sequenceTaskMode: sequenceTaskMode as "fl2va" | "l2va",
          media:
            taskMode === "i2va"
              ? { firstFrame: source }
              : { lastFrame: source },
        },
      );
      const nodes = graphNodes(result.workflow);
      const anchor = nodes.find((node) => node.id === result.anchorNodeId)!;
      expect(
        nodes.some(
          (node) =>
            node.type === "ImageScaleToTotalPixels" ||
            node.type === "GetImageSize",
        ),
      ).toBe(false);
      expect(origin(result.workflow, anchor, "width")).toBeUndefined();
      expect(origin(result.workflow, anchor, "height")).toBeUndefined();
      // Length is a linked expression; only the PrimitiveFloat changes for six seconds.
      expect(anchor.widgets_values).toEqual([512, 512, 124]);
    },
  );

  it.each(["fl2va", "l2va", "t2va"])(
    "refuses a geometry donor on global %s",
    (sequenceTaskMode) => {
      expect(() =>
        spliceContextPipeline(syntheticTemplate("video_minimax_h3_t2v"), {
          ...base,
          taskMode: "t2va",
          sequenceTaskMode: sequenceTaskMode as never,
          media: { geometryDonor: source },
        }),
      ).toThrow(/geometry/);
    },
  );
});
