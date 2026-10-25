import {
  classifyHostMappingReadiness,
  HOST_NODE_DEFINITION_CEILING,
} from "./hostSeamContract";

export const IMAGE_CROP_NODE_TYPE = "ImageCropV2";
// ComfyUI comfy_api/latest/_io.py:1488 declares IO.BoundingBox's native wire type.
// CRITICAL: dropping BOUNDING_BOX's underscore
// disables crop admission and gives inserted crop_region inputs the wrong type.
export const IMAGE_CROP_REGION_TYPE = "BOUNDING_BOX";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Consume the typed LiteGraph.registered_node_types observation, without a direct host read. */
export function readImageCropCapability(
  definitions: unknown,
  ready: boolean,
): boolean {
  if (classifyHostMappingReadiness(definitions, ready) !== "ready")
    return false;
  const entries = Object.values(record(definitions)!);
  if (entries.length > HOST_NODE_DEFINITION_CEILING) return false;
  const matches = entries.flatMap((entry) => {
    if (
      entry === null ||
      (typeof entry !== "object" && typeof entry !== "function")
    )
      return [];
    const data = record((entry as { nodeData?: unknown }).nodeData);
    return data?.name === IMAGE_CROP_NODE_TYPE ? [data] : [];
  });
  if (matches.length !== 1) return false;
  const required = record(record(matches[0]!.input)?.required);
  return (
    Array.isArray(required?.image) &&
    required.image[0] === "IMAGE" &&
    Array.isArray(required.crop_region) &&
    required.crop_region[0] === IMAGE_CROP_REGION_TYPE
  );
}
