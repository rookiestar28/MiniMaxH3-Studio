import { describe, expect, it } from "vitest";
import {
  applyPreparedSequenceCrops,
  resolvePreparedSequenceSpliceMedia,
} from "../src/host/preparedSequenceMedia";
import {
  spliceContextPipeline,
  type Json,
} from "../src/host/templateMaterialization";
import { validateSerializedLinks } from "../src/host/graphAdapter";
import { preparedSequenceMediaFixture as fixture } from "./support/preparedSequenceMediaFixture";
import { syntheticTemplate } from "./support/templateFixture";

describe("private prepared sequence media materialization", () => {
  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["i2va", "fl2va"],
    ["l2va", "fl2va"],
    ["fl2va", "fl2va"],
    ["l2va", "l2va"],
    ["t2va", "fl2va"],
  ] as const)(
    "maps retained bindings for child %s of %s without consulting the replaced canvas",
    (task, global) => {
      const { inputs, prepared } = fixture(task, global);
      const media = resolvePreparedSequenceSpliceMedia(inputs, prepared);
      if (inputs.first_frame_source)
        expect(media.firstFrame).toEqual({
          type: "LoadImage",
          widgetValues: ["synthetic/first_frame.png", "image"],
        });
      if (inputs.last_frame_source)
        expect(media.lastFrame).toEqual({
          type: "LoadImage",
          widgetValues: ["synthetic/last_frame.png", "image"],
        });
      expect(media.geometryDonor).toEqual(
        task === "t2va" && global === "i2va"
          ? {
              type: "LoadImage",
              widgetValues: ["synthetic/first_frame.png", "image"],
            }
          : undefined,
      );
      for (const source of [
        media.firstFrame,
        media.lastFrame,
        media.geometryDonor,
      ].filter((source) => source !== undefined))
        expect(Object.hasOwn(source, "crop")).toBe(false);
    },
  );

  it.each(["i2va", "t2va", "fl2va"] as const)(
    "reroutes every %s consumer through the exact retained region without source dimensions",
    (task) => {
      const global = task === "fl2va" ? "fl2va" : "i2va";
      const { inputs, prepared } = fixture(task, global, true);
      const media = resolvePreparedSequenceSpliceMedia(inputs, prepared);
      const spliced = spliceContextPipeline(
        syntheticTemplate(
          task === "t2va" ? "video_minimax_h3_t2v" : "video_minimax_h3_i2v",
        ),
        {
          taskMode: task,
          sequenceTaskMode: global,
          userIntent: inputs.user_intent,
          durationSeconds: 6,
          media,
        },
      );
      const before = structuredClone(spliced);
      const result = applyPreparedSequenceCrops(spliced, inputs, prepared);
      expect(spliced).toEqual(before);
      const graph = result.workflow,
        nodes = graph.nodes as Json[],
        edges = graph.links as unknown[][];
      for (const [loaderId, crop] of Object.entries(
        result.mediaNodeIds.retainedCrops!,
      )) {
        const node = nodes.find((node) => node.id === crop.nodeId)!;
        expect(node.type).toBe("ImageCropV2");
        expect(node.widgets_values).toEqual([
          { x: 16, y: 32, width: 96, height: 64 },
        ]);
        expect(crop.region).toEqual({ x: 16, y: 32, width: 96, height: 64 });
        const direct = edges.filter(
          (edge) => String(edge[1]) === loaderId && edge[2] === 0,
        );
        expect(direct).toHaveLength(1);
        expect(direct[0]![3]).toBe(crop.nodeId);
        const oldConsumers = (before.workflow.links as unknown[][]).filter(
          (edge) => String(edge[1]) === loaderId && edge[2] === 0,
        );
        for (const edge of oldConsumers)
          expect(edges.find((row) => row[0] === edge[0])!.slice(1)).toEqual([
            crop.nodeId,
            ...edge.slice(2),
          ]);
      }
      expect(Object.keys(result.mediaNodeIds.retainedCrops!)).toHaveLength(
        prepared.bindings!.entries.length,
      );
      expect(validateSerializedLinks(graph, nodes)).toBeUndefined();
    },
  );

  it.each(["selector", "missing", "donor", "extra_role", "ordinary_crop"])(
    "refuses %s before a child is written",
    (defect) => {
      const { inputs, prepared } = fixture("i2va", "i2va");
      const changed: any = structuredClone(prepared);
      if (defect === "selector") inputs.first_frame_source = "999";
      if (defect === "missing") changed.bindings = null;
      if (defect === "donor") changed.geometryDonorAssetId = null;
      if (defect === "extra_role")
        changed.bindings.entries[0].role = "reference";
      if (defect === "ordinary_crop") inputs.image_crops = {};
      expect(() => resolvePreparedSequenceSpliceMedia(inputs, changed)).toThrow(
        /sequence_media/,
      );
    },
  );
});
