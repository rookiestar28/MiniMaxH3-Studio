import { describe, expect, it } from "vitest";
import { matchesPreparedSequenceMedia } from "../src/host/preparedSequenceAdmission";
import { preparedSequenceExecutionSources } from "../src/host/preparedSequenceObservation";
import { preparedTemplateGeometryFixture } from "./support/preparedSequenceTemplateGeometryFixture";

describe("prepared frame child template geometry", () => {
  it.each([
    ["i2va", "fl2va"],
    ["l2va", "l2va"],
  ] as const)(
    "admits %s child of %s with the official dormant size branch",
    (task, parent) => {
      const { inputs, prepared, template, before, result, compiled } =
        preparedTemplateGeometryFixture(task, parent);
      const output = compiled.output as Record<
        string,
        { class_type: string; inputs: Record<string, unknown> }
      >;
      expect(template).toEqual(before);
      expect(output["28"]!.inputs.image).toBeUndefined();
      expect(output["29"]!.inputs).toEqual({ image: ["28", 0] });
      const { native } = preparedSequenceExecutionSources(
        compiled,
        result.mediaNodeIds,
        inputs,
      );
      expect(native.width).toEqual(["27", 0]);
      expect(native.height).toEqual(["27", 1]);
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
    "anchor_width",
    "anchor_height",
    "size_width_consumer",
    "size_height_consumer",
    "size_batch_consumer",
    "linked_scale_image",
    "literal_scale_image",
    "extra_scale",
    "extra_size",
    "missing_size",
    "missing_scale",
    "wrong_size_source",
    "wrong_size_slot",
    "extra_size_input",
    "external_scale_consumer",
    "other_scale_slot_consumer",
  ])(
    "refuses an active or malformed template geometry branch: %s",
    (defect) => {
      const { inputs, prepared, result, compiled } =
        preparedTemplateGeometryFixture("i2va", "fl2va");
      const output = compiled.output as Record<
        string,
        { class_type: string; inputs: Record<string, unknown> }
      >;
      const native = Object.values(output).find(
        (node) => node.class_type === "MiniMaxH3ImageToVideo",
      )!;
      if (defect === "anchor_width") native.inputs.width = ["29", 0];
      if (defect === "anchor_height") native.inputs.height = ["29", 1];
      if (defect.startsWith("size_") && defect.endsWith("_consumer"))
        output.consumer = {
          class_type: "SyntheticConsumer",
          inputs: {
            value: [
              "29",
              defect === "size_width_consumer"
                ? 0
                : defect === "size_height_consumer"
                  ? 1
                  : 2,
            ],
          },
        };
      if (defect === "linked_scale_image")
        output["28"]!.inputs.image = [
          String(result.mediaNodeIds.firstFrame),
          0,
        ];
      if (defect === "literal_scale_image")
        output["28"]!.inputs.image = "literal";
      if (defect === "extra_scale")
        output.extra = structuredClone(output["28"]!);
      if (defect === "extra_size")
        output.extra = structuredClone(output["29"]!);
      if (defect === "missing_size") delete output["29"];
      if (defect === "missing_scale") delete output["28"];
      if (defect === "wrong_size_source")
        output["29"]!.inputs.image = [
          String(result.mediaNodeIds.firstFrame),
          0,
        ];
      if (defect === "wrong_size_slot") output["29"]!.inputs.image = ["28", 1];
      if (defect === "extra_size_input") output["29"]!.inputs.extra = ["28", 0];
      if (
        defect.endsWith("scale_consumer") ||
        defect === "other_scale_slot_consumer"
      )
        output.consumer = {
          class_type: "SyntheticConsumer",
          inputs: {
            value: ["28", defect === "other_scale_slot_consumer" ? 1 : 0],
          },
        };
      expect(
        matchesPreparedSequenceMedia(
          compiled,
          result.mediaNodeIds,
          inputs,
          prepared,
        ),
      ).toBe(false);
    },
  );
});
