import { AppModeError, type AppModeInputs } from "./appModeContract";
import {
  MAX_CROP_DIMENSION,
  MIN_CROP_SIZE,
  type ImageCrop,
} from "./imageCropGeometry";

export type ImageCrops = Readonly<Record<string, ImageCrop>>;
const FIELDS = ["x", "y", "w", "h", "sourceWidth", "sourceHeight"] as const;

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  // IMPORTANT: hidden fields evade Object.keys; reject them too so private extras
  // cannot accompany the closed numeric crop or selected-source map.
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !("value" in descriptors[key]!) ||
        descriptors[key]!.enumerable !== true,
    )
  )
    return undefined;
  return value as Record<string, unknown>;
}

export function isImageCrop(value: unknown): value is ImageCrop {
  const crop = dataRecord(value);
  if (
    crop === undefined ||
    Object.keys(crop).length !== FIELDS.length ||
    !FIELDS.every(
      (key) =>
        Number.isSafeInteger(crop[key]) &&
        Number(crop[key]) >= 0 &&
        Number(crop[key]) <= MAX_CROP_DIMENSION,
    )
  )
    return false;
  const c = crop as unknown as ImageCrop;
  return (
    c.w >= MIN_CROP_SIZE &&
    c.h >= MIN_CROP_SIZE &&
    c.x + c.w <= c.sourceWidth &&
    c.y + c.h <= c.sourceHeight
  );
}

export function validateImageCrops(
  inputs: AppModeInputs,
  canvasOnly: boolean,
): void {
  if (inputs.image_crops === undefined) return;
  const crops = dataRecord(inputs.image_crops);
  const selected =
    inputs.task_mode === "ref2va"
      ? (inputs.reference_image_sources ?? [])
      : inputs.task_mode === "t2va"
        ? []
        : [inputs.first_frame_source, inputs.last_frame_source].filter(
            (id): id is string => id !== undefined,
          );
  // CRITICAL: crops are a canvas-preparation operation. Never silently drop
  // them on a queue route or apply them to an unselected image identity.
  if (
    !canvasOnly ||
    crops === undefined ||
    Object.keys(crops).length === 0 ||
    Object.keys(crops).length > 9 ||
    Object.entries(crops).some(
      ([id, crop]) => !selected.includes(id) || !isImageCrop(crop),
    )
  )
    throw new AppModeError(
      "invalid_request",
      "crop requests require selected preparation images and bounded integer rectangles",
      { kind: "image_crop_invalid" },
    );
}
