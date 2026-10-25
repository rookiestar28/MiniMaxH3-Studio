import {
  AppModeError,
  type AppModeApi,
  type AppModeInputs,
} from "./appModeContract";
import { buildManagedSourceIdentityRequest } from "./appModeManagedPreparation";
import { probeFileUrl } from "./hostSeams";
import { isImageCrop } from "./imageCropContract";
import {
  MAX_CROP_DIMENSION,
  MIN_CROP_SIZE,
  type ImageCrop,
} from "./imageCropGeometry";

export type SourceImageSize = Readonly<{ width: number; height: number }>;
export type MeasureSourceImage = (url: string) => Promise<SourceImageSize>;
export type CropSourceImage = SourceImageSize & Readonly<{ url: string }>;
export type ImageCropSourceActions = Readonly<{
  open(id: string): Promise<CropSourceImage>;
  apply(id: string, crop: ImageCrop | undefined): void;
  clear(): void;
}>;

const stale = () =>
  new AppModeError("invalid_request", "the image changed; crop it again", {
    kind: "image_crop_stale",
  });
const unavailable = () =>
  new AppModeError("incompatible_seam", "the crop image could not be opened", {
    kind: "image_crop_unavailable",
  });

/** Build a same-origin image URL through the typed api.fileURL seam. */
export function buildCropImageUrl(
  api: AppModeApi,
  locator: string,
  origin: string = globalThis.location.origin,
): string {
  const match = /^(.*?)(?: \[(input|output|temp)\])?$/.exec(locator);
  const parts = (match?.[1] ?? "").replaceAll("\\", "/").split("/");
  if (
    locator.length > 1024 ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        /[:\x00-\x1f\x7f]/.test(part),
    )
  )
    throw unavailable();
  const filename = parts.pop()!;
  const params = new URLSearchParams({
    filename,
    subfolder: parts.join("/"),
    type: match?.[2] ?? "input",
  });
  const seam = probeFileUrl(api);
  if (seam.status !== "ready") throw unavailable();
  const url = new URL(seam.value(`/view?${params}`), origin);
  // CRITICAL: this image read stays on the current ComfyUI origin. Preview or
  // channel parameters re-encode pixels and break LoadImage's EXIF orientation.
  if (
    url.origin !== new URL(origin).origin ||
    !url.pathname.endsWith("/view") ||
    url.username ||
    url.password ||
    url.searchParams.has("preview") ||
    url.searchParams.has("channel")
  )
    throw unavailable();
  return url.href;
}

const measureBrowserImage: MeasureSourceImage = async (url) => {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw unavailable();
  const image = await createImageBitmap(await response.blob(), {
    imageOrientation: "from-image",
  });
  try {
    return { width: image.width, height: image.height };
  } finally {
    image.close();
  }
};

export function createImageCropSources(options: {
  api: AppModeApi;
  readGraph: () => unknown;
  measureSourceImage?: MeasureSourceImage;
  origin?: string;
}) {
  const measure = options.measureSourceImage ?? measureBrowserImage;
  const opened = new Map<string, { locator: string; size: SourceImageSize }>();
  const applied = new Map<string, { locator: string; crop: ImageCrop }>();
  const locatorOf = (id: string) =>
    buildManagedSourceIdentityRequest(options.readGraph(), id).locator;
  const dimensionsValid = (size: SourceImageSize) =>
    [size.width, size.height].every(
      (n) =>
        Number.isSafeInteger(n) &&
        n >= MIN_CROP_SIZE &&
        n <= MAX_CROP_DIMENSION,
    );
  return {
    async open(id: string): Promise<CropSourceImage> {
      const locator = locatorOf(id);
      const url = buildCropImageUrl(options.api, locator, options.origin);
      let size: SourceImageSize;
      try {
        size = await measure(url);
      } catch {
        throw unavailable();
      }
      if (!dimensionsValid(size) || locatorOf(id) !== locator) throw stale();
      opened.set(id, { locator, size: { ...size } });
      return { url, ...size };
    },
    apply(id: string, crop: ImageCrop | undefined): void {
      if (crop === undefined) {
        applied.delete(id);
        opened.delete(id);
        return;
      }
      const source = opened.get(id);
      if (
        !isImageCrop(crop) ||
        source === undefined ||
        source.locator !== locatorOf(id) ||
        crop.sourceWidth !== source.size.width ||
        crop.sourceHeight !== source.size.height
      )
        throw stale();
      applied.set(id, { locator: source.locator, crop: { ...crop } });
    },
    clear(): void {
      opened.clear();
      applied.clear();
    },
    async validate(inputs: AppModeInputs): Promise<void> {
      for (const [id, crop] of Object.entries(inputs.image_crops ?? {})) {
        try {
          const remembered = applied.get(id);
          if (
            remembered === undefined ||
            remembered.locator !== locatorOf(id) ||
            Object.entries(crop).some(
              ([key, value]) =>
                remembered.crop[key as keyof ImageCrop] !== value,
            )
          )
            throw stale();
          const size = await measure(
            buildCropImageUrl(options.api, remembered.locator, options.origin),
          );
          if (
            !dimensionsValid(size) ||
            size.width !== crop.sourceWidth ||
            size.height !== crop.sourceHeight ||
            remembered.locator !== locatorOf(id)
          )
            throw stale();
        } catch {
          throw stale();
        }
      }
    },
  };
}
