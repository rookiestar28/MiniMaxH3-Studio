/** Integer source-pixel rectangles; never view pixels or image locators. */
export type ImageCrop = Readonly<{
  x: number;
  y: number;
  w: number;
  h: number;
  sourceWidth: number;
  sourceHeight: number;
}>;

export type CropRatio = readonly [number, number];
export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export const MIN_CROP_SIZE = 32;
export const MAX_CROP_DIMENSION = 16_384;

const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, Math.round(n)));

export function fullImageCrop(width: number, height: number): ImageCrop {
  return {
    x: 0,
    y: 0,
    w: width,
    h: height,
    sourceWidth: width,
    sourceHeight: height,
  };
}

export function isFullImageCrop(crop: ImageCrop): boolean {
  return (
    crop.x === 0 &&
    crop.y === 0 &&
    crop.w === crop.sourceWidth &&
    crop.h === crop.sourceHeight
  );
}

export function clampCrop(crop: ImageCrop): ImageCrop {
  const w = clamp(crop.w, MIN_CROP_SIZE, crop.sourceWidth);
  const h = clamp(crop.h, MIN_CROP_SIZE, crop.sourceHeight);
  return {
    ...crop,
    w,
    h,
    x: clamp(crop.x, 0, crop.sourceWidth - w),
    y: clamp(crop.y, 0, crop.sourceHeight - h),
  };
}

export function moveCrop(crop: ImageCrop, dx: number, dy: number): ImageCrop {
  return clampCrop({ ...crop, x: crop.x + dx, y: crop.y + dy });
}

export function reducedRatio(p: number, q: number): CropRatio {
  if (
    !Number.isSafeInteger(p) ||
    !Number.isSafeInteger(q) ||
    p <= 0 ||
    q <= 0 ||
    p > MAX_CROP_DIMENSION ||
    q > MAX_CROP_DIMENSION
  )
    throw new RangeError("crop ratio must contain bounded positive integers");
  let a = p;
  let b = q;
  while (b !== 0) [a, b] = [b, a % b];
  return [p / a, q / a];
}

export function applyRatio(
  crop: ImageCrop,
  p: number,
  q: number,
): ImageCrop | undefined {
  [p, q] = reducedRatio(p, q);
  const k = Math.floor(Math.min(crop.w / p, crop.h / q));
  if (p * k < MIN_CROP_SIZE || q * k < MIN_CROP_SIZE) return undefined;
  // IMPORTANT: round one shared integer multiplier, never width and height
  // independently; independent rounding breaks the exact requested aspect.
  const w = p * k;
  const h = q * k;
  return clampCrop({
    ...crop,
    w,
    h,
    x: crop.x + (crop.w - w) / 2,
    y: crop.y + (crop.h - h) / 2,
  });
}

export function resizeCrop(
  crop: ImageCrop,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio?: CropRatio,
  input: "pointer" | "keyboard" = "pointer",
): ImageCrop {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  const left = west
    ? clamp(crop.x + dx, 0, crop.x + crop.w - MIN_CROP_SIZE)
    : crop.x;
  const right = east
    ? clamp(crop.x + crop.w + dx, crop.x + MIN_CROP_SIZE, crop.sourceWidth)
    : crop.x + crop.w;
  const top = north
    ? clamp(crop.y + dy, 0, crop.y + crop.h - MIN_CROP_SIZE)
    : crop.y;
  const bottom = south
    ? clamp(crop.y + crop.h + dy, crop.y + MIN_CROP_SIZE, crop.sourceHeight)
    : crop.y + crop.h;
  if (ratio === undefined)
    return { ...crop, x: left, y: top, w: right - left, h: bottom - top };
  const [p, q] = reducedRatio(...ratio);
  const horizontal = west || east;
  const vertical = north || south;
  const keyboard = input === "keyboard";
  // IMPORTANT: preserve a canonical integer center between keyboard nudges. Reusing
  // a rounded half-pixel center walks the untouched axis on each odd-sized resize.
  const centerX = crop.x + crop.w / 2;
  const centerY = crop.y + crop.h / 2;
  const fixedX = west
    ? crop.x + crop.w
    : east
      ? crop.x
      : keyboard
        ? Math.floor(centerX)
        : centerX;
  const fixedY = north
    ? crop.y + crop.h
    : south
      ? crop.y
      : keyboard
        ? Math.floor(centerY)
        : centerY;
  const maxW = west
    ? fixedX
    : east
      ? crop.sourceWidth - fixedX
      : keyboard
        ? Math.min(2 * fixedX + 1, 2 * (crop.sourceWidth - fixedX))
        : 2 * Math.min(fixedX, crop.sourceWidth - fixedX);
  const maxH = north
    ? fixedY
    : south
      ? crop.sourceHeight - fixedY
      : keyboard
        ? Math.min(2 * fixedY + 1, 2 * (crop.sourceHeight - fixedY))
        : 2 * Math.min(fixedY, crop.sourceHeight - fixedY);
  const minK = Math.ceil(Math.max(MIN_CROP_SIZE / p, MIN_CROP_SIZE / q));
  const maxK = Math.floor(Math.min(maxW / p, maxH / q));
  if (maxK < minK) return crop;
  const useWidth =
    horizontal && (!vertical || Math.abs(dx) / p >= Math.abs(dy) / q);
  const desiredK = useWidth ? (right - left) / p : (bottom - top) / q;
  const currentK = crop.w / p;
  // A keyboard growth nudge must reach the next ratio step; pointer movement keeps
  // the largest multiplier fitting the requested box, rather than overshooting it.
  const roundedK =
    keyboard && desiredK > currentK
      ? Math.ceil(desiredK)
      : Math.floor(desiredK);
  const k = clamp(roundedK, minK, maxK);
  if (keyboard && k === currentK) return crop;
  const w = p * k;
  const h = q * k;
  return {
    ...crop,
    w,
    h,
    x:
      keyboard && !horizontal
        ? fixedX - Math.floor(w / 2)
        : Math.round(west ? fixedX - w : east ? fixedX : fixedX - w / 2),
    y:
      keyboard && !vertical
        ? fixedY - Math.floor(h / 2)
        : Math.round(north ? fixedY - h : south ? fixedY : fixedY - h / 2),
  };
}
