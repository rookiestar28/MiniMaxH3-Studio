/** Private loopback execution media. This state never enters a durable projection. */
import type { AppModeInputs } from "./appModeContract";
import {
  IMAGE_CROP_NODE_TYPE,
  IMAGE_CROP_REGION_TYPE,
} from "./imageCropCapability";
import {
  decodeSequenceMediaBindingSet,
  SequenceMediaBindingError,
  type SequenceMediaBindingSet,
} from "./sequenceMediaBindings";
import { sequenceUsesSourceGeometry } from "./sequenceGeometry";
import {
  FRAME_BINDINGS,
  type Json,
  type LoaderSource,
  type SpliceMedia,
  type SpliceResult,
} from "./templateGraphTopology";

export type PreparedSequenceMedia = Readonly<{
  sequenceTaskMode: "i2va" | "l2va" | "fl2va";
  bindings: SequenceMediaBindingSet | null;
  geometryDonorAssetId: string | null;
}>;

const changed = (): never => {
  throw new SequenceMediaBindingError("sequence_media_changed", {
    origin: "media-shape",
    boundary: "materialize",
    managedAction: "unattributed",
    httpStatusClass: "unattributed",
  });
};
const changedAtSelector = (): never => {
  throw new SequenceMediaBindingError("sequence_media_changed", {
    origin: "media-selector",
    boundary: "materialize",
    managedAction: "unattributed",
    httpStatusClass: "unattributed",
  });
};
const unavailable = (): never => {
  throw new SequenceMediaBindingError("sequence_media_unavailable");
};

/** Original canvas IDs are selectors only; the retained binding supplies the source. */
export function resolvePreparedSequenceSpliceMedia(
  inputs: AppModeInputs,
  prepared: PreparedSequenceMedia,
): SpliceMedia {
  if (
    Object.keys(prepared).length !== 3 ||
    inputs.image_crops !== undefined ||
    inputs.reference_image_sources !== undefined ||
    inputs.reference_video_sources !== undefined ||
    inputs.reference_audio_sources !== undefined ||
    !["t2va", "i2va", "l2va", "fl2va"].includes(inputs.task_mode)
  )
    return changed();
  const bindings =
    prepared.bindings === null
      ? null
      : decodeSequenceMediaBindingSet(prepared.bindings);
  const entries = bindings?.entries ?? [];
  const roles = FRAME_BINDINGS[inputs.task_mode] ?? changed();
  const needed = new Set(roles);
  if (prepared.sequenceTaskMode === "i2va") needed.add("first_frame");
  if (
    entries.length !== needed.size ||
    new Set(entries.map((row) => row.role)).size !== entries.length ||
    entries.some((row) => !needed.has(row.role as "first_frame" | "last_frame"))
  )
    return unavailable();
  const source = (role: "first_frame" | "last_frame"): LoaderSource => {
    const entry = entries.find((row) => row.role === role) ?? unavailable();
    const selector =
      role === "first_frame"
        ? inputs.first_frame_source
        : inputs.last_frame_source;
    if (
      roles.includes(role)
        ? selector !== entry.loader_node_id
        : selector !== undefined
    )
      return changedAtSelector();
    return { type: "LoadImage", widgetValues: [entry.locator, "image"] };
  };
  if (
    (!roles.includes("first_frame") &&
      inputs.first_frame_source !== undefined) ||
    (!roles.includes("last_frame") && inputs.last_frame_source !== undefined)
  )
    return changed();
  const donor = entries.find(
    (row) => row.asset_id === prepared.geometryDonorAssetId,
  );
  if (
    prepared.sequenceTaskMode === "i2va"
      ? donor === undefined || donor.role !== "first_frame"
      : prepared.geometryDonorAssetId !== null
  )
    return changed();
  const media: SpliceMedia = {
    ...(roles.includes("first_frame")
      ? { firstFrame: source("first_frame") }
      : {}),
    ...(roles.includes("last_frame")
      ? { lastFrame: source("last_frame") }
      : {}),
    ...(prepared.sequenceTaskMode === "i2va" && inputs.task_mode === "t2va"
      ? { geometryDonor: source("first_frame") }
      : {}),
  };
  sequenceUsesSourceGeometry({
    taskMode: inputs.task_mode,
    sequenceTaskMode: prepared.sequenceTaskMode,
    userIntent: inputs.user_intent,
    durationSeconds: inputs.duration_milliseconds / 1000,
    media,
  });
  return media;
}

/** Insert the retained native region directly; never invent original image dimensions. */
export function applyPreparedSequenceCrops(
  result: SpliceResult,
  inputs: AppModeInputs,
  prepared: PreparedSequenceMedia,
): SpliceResult {
  resolvePreparedSequenceSpliceMedia(inputs, prepared);
  const entries = prepared.bindings?.entries ?? [];
  if (
    result.mediaNodeIds.crops !== undefined ||
    result.mediaNodeIds.retainedCrops !== undefined
  )
    return changed();
  if (!entries.some((row) => row.transform !== null)) return result;
  const cloned = structuredClone(result);
  const workflow = cloned.workflow,
    nodes = workflow.nodes as Json[],
    links = workflow.links as unknown[][];
  let nextNode = Number(workflow.last_node_id) + 1,
    nextLink = Number(workflow.last_link_id) + 1;
  if (!Number.isSafeInteger(nextNode) || !Number.isSafeInteger(nextLink))
    return changed();
  const crops: Record<
    string,
    {
      nodeId: number;
      region: NonNullable<
        SequenceMediaBindingSet["entries"][number]["transform"]
      >["region"];
    }
  > = {};
  for (const entry of entries) {
    if (entry.transform === null) continue;
    const loaderId =
      entry.role === "first_frame"
        ? (result.mediaNodeIds.firstFrame ?? result.mediaNodeIds.geometryDonor)
        : result.mediaNodeIds.lastFrame;
    const loaders = nodes.filter((node) => node.id === loaderId);
    if (loaders.length !== 1) return unavailable();
    const loader = loaders[0]!;
    if (
      loader.type !== "LoadImage" ||
      !Array.isArray(loader.widgets_values) ||
      loader.widgets_values[0] !== entry.locator ||
      !Array.isArray(loader.outputs) ||
      !Array.isArray((loader.outputs[0] as Json)?.links)
    )
      return changed();
    const consumers = links.filter(
      (edge) => edge[1] === loaderId && edge[2] === 0,
    );
    if (!consumers.length || consumers.some((edge) => edge[5] !== "IMAGE"))
      return changed();
    const nodeId = nextNode++,
      linkId = nextLink++;
    const region = { ...entry.transform.region };
    // CRITICAL: Registry, native frame, guide and source-size branches must consume
    // the same cropped IMAGE. A direct loader edge executes a different declaration.
    for (const edge of consumers) edge[1] = nodeId;
    (loader.outputs[0] as Json).links = [linkId];
    const position = Array.isArray(loader.pos) ? loader.pos : [-2900, -1200];
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
      widgets_values: [region],
    });
    links.push([linkId, loaderId, 0, nodeId, 0, "IMAGE"]);
    crops[String(loaderId)] = { nodeId, region };
  }
  workflow.last_node_id = nextNode - 1;
  workflow.last_link_id = nextLink - 1;
  return {
    ...cloned,
    mediaNodeIds: { ...cloned.mediaNodeIds, retainedCrops: crops },
  };
}
