import { syntheticTemplate, type Json } from "./templateFixture";

/** Explicit native VAE/positive branches required by the closing guide; no mode defaults. */
export function sequenceTemplateFixture(
  task: "t2va" | "i2va" | "l2va" | "fl2va",
): Json {
  const template = syntheticTemplate(
    task === "t2va" ? "video_minimax_h3_t2v" : "video_minimax_h3_i2v",
  );
  const anchor = (template.nodes as Json[]).find((node) => node.id === 3)!;
  (anchor.inputs as Json[]).find((port) => port.name === "vae")!.link = 22;
  (anchor.outputs as Json[])[0]!.links = [23];
  (template.nodes as Json[]).push(
    {
      id: 25,
      type: "VAELoader",
      inputs: [],
      outputs: [{ name: "VAE", type: "VAE", links: [22] }],
    },
    {
      id: 26,
      type: "BasicGuider",
      inputs: [{ name: "conditioning", type: "CONDITIONING", link: 23 }],
      outputs: [],
    },
  );
  (template.links as unknown[][]).push(
    [22, 25, 0, 3, 1, "VAE"],
    [23, 3, 0, 26, 0, "CONDITIONING"],
  );
  template.last_node_id = 26;
  template.last_link_id = 23;
  return template;
}
