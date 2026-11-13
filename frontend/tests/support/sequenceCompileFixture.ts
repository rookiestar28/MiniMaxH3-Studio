import type { AppModeCompiledPrompt } from "../../src/host/appMode";
import type { Json } from "./templateFixture";

/** Lower actual production edges; widget names mirror the explicit synthetic native schema. */
export function compileSequenceWorkflow(
  workflow: Json,
  aliasCrop: boolean,
): AppModeCompiledPrompt {
  const names: Record<string, string[]> = {
    LoadImage: ["image"],
    ImageCropV2: ["crop_region"],
    PrimitiveFloat: ["value"],
    ComfyMathExpression: ["expression"],
    ImageScaleToTotalPixels: [
      "upscale_method",
      "megapixels",
      "resolution_steps",
    ],
    MiniMaxH3AddGuide: ["frame_idx"],
    CreateVideo: ["fps", "unused"],
    SaveVideo: ["filename_prefix", "format", "codec"],
    VAELoader: ["vae_name"],
    CLIPLoader: ["clip_name", "type"],
  };
  const links = workflow.links as unknown[][];
  return {
    output: Object.fromEntries(
      (workflow.nodes as Json[]).map((node) => {
        const inputs: Record<string, unknown> = {};
        const ports = (node.inputs ?? []) as Json[];
        const widgets = (node.widgets_values ?? []) as unknown[];
        const widgetNames =
          names[String(node.type)] ??
          ports
            .filter((port) => port.widget !== undefined)
            .map((port) => String(port.name));
        widgetNames.forEach((name, index) => {
          if (widgets[index] !== undefined) inputs[name] = widgets[index];
        });
        for (const port of ports) {
          const edge = links.find((edge) => edge[0] === port.link);
          if (edge !== undefined)
            inputs[String(port.name)] = [String(edge[1]), edge[2]];
        }
        return [
          String(node.id),
          {
            class_type: node.type,
            inputs:
              aliasCrop && node.type === "ImageCropV2"
                ? inputs
                : structuredClone(inputs),
          },
        ];
      }),
    ),
    workflow: {},
  };
}
