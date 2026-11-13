import { sequenceTemplateFixture } from "./sequenceTemplateFixture";
import type { Json } from "./templateFixture";

/** Opt-in native dimension seam; keep the default fixture and its other callers unchanged. */
export function nativeCanvasSequenceTemplateFixture(name: string): Json {
  if (name !== "video_minimax_h3_i2v" && name !== "video_minimax_h3_t2v")
    throw new Error("unsupported synthetic native canvas template");
  const i2v = name === "video_minimax_h3_i2v";
  const template = sequenceTemplateFixture(i2v ? "i2va" : "t2va");
  const nodes = template.nodes as Json[];
  const links = template.links as unknown[][];
  const anchor = nodes.find((node) => node.id === 3)!;
  const inputs = anchor.inputs as Json[];
  const values = [i2v ? "1:1 (Square)" : "16:9 (Widescreen)", 0.4, 32];
  for (const [slot, name] of ["width", "height"].entries()) {
    const targetSlot = inputs.findIndex((input) => input.name === name);
    inputs[targetSlot]!.link = 26 + slot;
    links.push([26 + slot, 28, slot, anchor.id, targetSlot, "INT"]);
  }
  // Keep node27 and links24/25 free for the callers' existing CLIP/VAE branches.
  nodes.push({
    id: 28,
    type: "ResolutionSelector",
    inputs: [],
    outputs: [
      { name: "width", type: "INT", links: [26] },
      { name: "height", type: "INT", links: [27] },
    ],
    widgets_values: values,
    widgets_values_named: {
      aspect_ratio: values[0],
      megapixels: values[1],
      multiple: values[2],
    },
  });
  template.last_node_id = 28;
  template.last_link_id = 27;
  return template;
}
