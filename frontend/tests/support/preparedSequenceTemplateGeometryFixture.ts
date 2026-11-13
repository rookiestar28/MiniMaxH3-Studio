import { applySequenceClosingGuide } from "../../src/host/sequenceFrameMaterialization";
import {
  applyPreparedSequenceCrops,
  resolvePreparedSequenceSpliceMedia,
} from "../../src/host/preparedSequenceMedia";
import {
  spliceContextPipeline,
  type Json,
} from "../../src/host/templateMaterialization";
import { preparedSequenceMediaFixture } from "./preparedSequenceMediaFixture";
import { compileSequenceWorkflow } from "./sequenceCompileFixture";
import { sequenceTemplateFixture } from "./sequenceTemplateFixture";

/** Synthetic geometry topology from comfyui_workflow_templates_json 0.1.122 video_minimax_h3_i2v. */
export function templateWithDormantSizeBranch(task: "i2va" | "l2va"): Json {
  const template = sequenceTemplateFixture(task);
  const nodes = template.nodes as Json[];
  const links = template.links as unknown[][];
  const anchor = nodes.find((node) => node.type === "MiniMaxH3ImageToVideo")!;
  const inputs = anchor.inputs as Json[];
  inputs.find((input) => input.name === "width")!.link = 24;
  inputs.find((input) => input.name === "height")!.link = 25;
  // The pinned template selects dimensions separately; its unused scale -> size pair
  // has no image source and no dimension consumer. Preserve that template topology.
  nodes.push(
    {
      id: 27,
      type: "ResolutionSelector",
      inputs: [],
      outputs: [
        { name: "width", type: "INT", links: [24] },
        { name: "height", type: "INT", links: [25] },
      ],
      widgets_values: ["16:9 (Widescreen)", 0.4, 32],
    },
    {
      id: 28,
      type: "ImageScaleToTotalPixels",
      inputs: [{ name: "image", type: "IMAGE", link: null }],
      outputs: [{ name: "IMAGE", type: "IMAGE", links: [26] }],
      widgets_values: ["nearest-exact", 0.9, 32],
    },
    {
      id: 29,
      type: "GetImageSize",
      inputs: [{ name: "image", type: "IMAGE", link: 26 }],
      outputs: [
        { name: "width", type: "INT", links: [] },
        { name: "height", type: "INT", links: [] },
        { name: "batch_size", type: "INT", links: [] },
      ],
      widgets_values: [],
    },
  );
  links.push(
    [
      24,
      27,
      0,
      anchor.id,
      inputs.findIndex((row) => row.name === "width"),
      "INT",
    ],
    [
      25,
      27,
      1,
      anchor.id,
      inputs.findIndex((row) => row.name === "height"),
      "INT",
    ],
    [26, 28, 0, 29, 0, "IMAGE"],
  );
  template.last_node_id = 29;
  template.last_link_id = 26;
  return template;
}

export function preparedTemplateGeometryFixture(
  task: "i2va" | "l2va",
  parent: "fl2va" | "l2va",
) {
  const { inputs, prepared } = preparedSequenceMediaFixture(task, parent);
  const template = templateWithDormantSizeBranch(task);
  const before = structuredClone(template);
  let result = spliceContextPipeline(template, {
    taskMode: inputs.task_mode,
    sequenceTaskMode: prepared.sequenceTaskMode,
    userIntent: inputs.user_intent,
    durationSeconds: inputs.duration_milliseconds / 1000,
    media: resolvePreparedSequenceSpliceMedia(inputs, prepared),
  });
  result = applyPreparedSequenceCrops(result, inputs, prepared);
  if (task === "l2va") result = applySequenceClosingGuide(result, 6);
  const compiled = compileSequenceWorkflow(result.workflow, false);
  return { inputs, prepared, template, before, result, compiled };
}
