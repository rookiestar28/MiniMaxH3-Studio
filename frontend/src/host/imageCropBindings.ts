import { IMAGE_CROP_NODE_TYPE } from "./imageCropCapability";
import { cropRegion } from "./imageCropInsertion";
import type { SpliceMediaIds } from "./templateGraphTopology";
import type { AppModeInputs } from "./appModeContract";

export function matchesRequestedImageCrops(
  inputs: AppModeInputs,
  ids: SpliceMediaIds | undefined,
): boolean {
  const chosen =
    inputs.task_mode === "ref2va"
      ? (inputs.reference_image_sources ?? [])
      : [inputs.first_frame_source, inputs.last_frame_source];
  const materialized =
    inputs.task_mode === "ref2va"
      ? (ids?.referenceImages ?? [])
      : [ids?.firstFrame, ids?.lastFrame];
  const crops = Object.entries(inputs.image_crops ?? {});
  if (Object.keys(ids?.crops ?? {}).length !== crops.length) return false;
  return crops.every(([id, crop]) => {
    const loader = materialized[chosen.indexOf(id)];
    const expected =
      loader === undefined ? undefined : ids?.crops?.[String(loader)]?.crop;
    return (
      expected !== undefined &&
      Object.entries(crop).every(
        ([key, value]) => expected[key as keyof typeof expected] === value,
      )
    );
  });
}

type Node = Readonly<{ class_type?: unknown; inputs?: unknown }>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const link = (value: unknown, id: string | number) =>
  Array.isArray(value) &&
  value.length === 2 &&
  (typeof value[0] === "string" || typeof value[0] === "number") &&
  String(value[0]) === String(id) &&
  value[1] === 0;

export function cropEndpoint(
  ids: SpliceMediaIds | undefined,
  loaderId: number | undefined,
): number | undefined {
  return loaderId === undefined
    ? undefined
    : (ids?.crops?.[String(loaderId)]?.nodeId ?? loaderId);
}

export function matchesImageCropNodes(
  ids: SpliceMediaIds | undefined,
  byId: ReadonlyMap<string, Node>,
): boolean {
  const expected = Object.entries(ids?.crops ?? {});
  const actual = [...byId].filter(
    ([, node]) => node.class_type === IMAGE_CROP_NODE_TYPE,
  );
  if (
    actual.length !== expected.length ||
    new Set(expected.map(([, row]) => row.nodeId)).size !== expected.length
  )
    return false;
  return expected.every(([loaderId, row]) => {
    const node = byId.get(String(row.nodeId));
    const input = record(node?.inputs);
    const region = record(input?.crop_region);
    return (
      node?.class_type === IMAGE_CROP_NODE_TYPE &&
      byId.get(loaderId)?.class_type === "LoadImage" &&
      link(input?.image, loaderId) &&
      region !== undefined &&
      Object.keys(region).length === 4 &&
      Object.entries(cropRegion(row.crop)).every(
        ([key, value]) => region[key] === value,
      )
    );
  });
}

/** Structural admission permits one native interposer per loader, never chains. */
export function validStructuralImageCrops(
  byId: ReadonlyMap<string, Node>,
): boolean {
  const seen = new Set<string>();
  for (const node of byId.values()) {
    if (node.class_type !== IMAGE_CROP_NODE_TYPE) continue;
    const inputs = record(node.inputs);
    const image = inputs?.image;
    const region = record(inputs?.crop_region);
    if (
      !Array.isArray(image) ||
      image.length !== 2 ||
      image[1] !== 0 ||
      !(typeof image[0] === "string" || typeof image[0] === "number") ||
      byId.get(String(image[0]))?.class_type !== "LoadImage" ||
      seen.has(String(image[0])) ||
      region === undefined ||
      Object.keys(region).length !== 4 ||
      !["x", "y", "width", "height"].every(
        (key) =>
          Number.isSafeInteger(region[key]) &&
          Number(region[key]) >=
            (key === "width" || key === "height" ? 32 : 0) &&
          Number(region[key]) <= 16384,
      ) ||
      Number(region.x) + Number(region.width) > 16384 ||
      Number(region.y) + Number(region.height) > 16384
    )
      return false;
    seen.add(String(image[0]));
  }
  return true;
}
