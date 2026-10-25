import { isImageCrop } from "./imageCropContract";
import {
  IMAGE_CROP_NODE_TYPE,
  IMAGE_CROP_REGION_TYPE,
} from "./imageCropCapability";
import {
  TemplateSpliceError,
  type Json,
  type SpliceMedia,
  type SpliceResult,
} from "./templateGraphTopology";
import type { ImageCrop } from "./imageCropGeometry";

export const cropRegion = (crop: ImageCrop) => ({
  x: crop.x,
  y: crop.y,
  width: crop.w,
  height: crop.h,
});

/** Lazy insertion preserves all uncropped workflow bytes and node/link IDs. */
export function applyImageCrops(
  result: SpliceResult,
  media: SpliceMedia | undefined,
  connecting: boolean,
): SpliceResult {
  const sources = [
    media?.firstFrame,
    media?.lastFrame,
    ...(media?.referenceImages ?? []),
  ];
  const ids = [
    result.mediaNodeIds.firstFrame,
    result.mediaNodeIds.lastFrame,
    ...result.mediaNodeIds.referenceImages,
  ];
  if (
    sources.some(
      (source) =>
        source?.crop !== undefined &&
        (connecting ||
          source.type !== "LoadImage" ||
          !isImageCrop(source.crop)),
    ) ||
    [...(media?.referenceVideos ?? []), ...(media?.referenceAudios ?? [])].some(
      (source) => source.crop !== undefined,
    )
  )
    throw new TemplateSpliceError(
      "invalid_crop",
      "crop requires a selected image and a bounded integer rectangle",
    );
  if (!sources.some((source) => source?.crop !== undefined)) return result;
  const workflow = result.workflow;
  const nodes = workflow.nodes as Json[];
  const links = workflow.links as unknown[][];
  let nextNode = Number(workflow.last_node_id) + 1;
  let nextLink = Number(workflow.last_link_id) + 1;
  const crops: Record<string, { nodeId: number; crop: ImageCrop }> = {};
  sources.forEach((source, index) => {
    const crop = source?.crop;
    if (crop === undefined) return;
    const loaderId = ids[index];
    const loader = nodes.find((node) => node.id === loaderId);
    if (loader === undefined)
      throw new TemplateSpliceError(
        "invalid_crop",
        "the crop image source is unavailable",
      );
    const consumers = links.filter(
      (link) => link[1] === loaderId && link[2] === 0,
    );
    const nodeId = nextNode++;
    const linkId = nextLink++;
    const position = Array.isArray(loader.pos) ? loader.pos : [-2900, -1200];
    // CRITICAL: every consumer, including I2VA scale, must use the same crop.
    // Leaving a direct edge executes a different image from Registry.
    for (const edge of consumers) edge[1] = nodeId;
    (loader.outputs as Json[])[0]!.links = [linkId];
    nodes.push({
      id: nodeId,
      type: IMAGE_CROP_NODE_TYPE,
      pos: [Number(position[0]) + 330, Number(position[1]) + 40],
      size: [280, 220],
      flags: {},
      order: nodes.length,
      mode: 0,
      properties: {},
      inputs: [
        { name: "image", type: "IMAGE", link: linkId },
        {
          name: "crop_region",
          type: IMAGE_CROP_REGION_TYPE,
          widget: { name: "crop_region" },
          link: null,
        },
      ],
      outputs: [
        {
          name: "IMAGE",
          type: "IMAGE",
          links: consumers.map((edge) => edge[0]),
          slot_index: 0,
        },
      ],
      widgets_values: [cropRegion(crop)],
    });
    links.push([linkId, loaderId, 0, nodeId, 0, "IMAGE"]);
    crops[String(loaderId)] = { nodeId, crop: { ...crop } };
  });
  workflow.last_node_id = nextNode - 1;
  workflow.last_link_id = nextLink - 1;
  return { ...result, mediaNodeIds: { ...result.mediaNodeIds, crops } };
}
