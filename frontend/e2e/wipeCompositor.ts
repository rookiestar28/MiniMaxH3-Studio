import fixture from "../../tests/fixtures/m25_10_composition_contract_v1.json";
import {
  decodePublicCompositionSnapshot,
  decodeResolvedScene,
  publicCompositionFingerprint,
  type WipeKind,
} from "../src/contracts/compositionCodec";
import { resolveCompositionScene } from "../src/runtime/sceneResolver";
import { createVisualCompositor } from "../src/runtime/visualCompositor";

async function solid(width: number, height: number, rgba: readonly number[]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4)
    pixels.set(rgba, offset);
  return createImageBitmap(new ImageData(pixels, width, height));
}

/** Actual Canvas2D pixel readback, with only the source bitmaps synthetic. */
export async function observeWipe(
  kind: WipeKind | "cross_dissolve_v1",
  native: boolean,
  rotated: boolean,
  downscaled = false,
) {
  const outputSize = downscaled ? 640 : 128;
  const previewSize = downscaled ? 320 : 128;
  const sourceWidth = downscaled ? 96 : 64;
  const sourceHeight = downscaled ? 72 : 48;
  const wire = structuredClone(fixture.snapshot);
  wire.output.width = wire.output.height = outputSize;
  for (const track of wire.tracks)
    track.enabled = track.kind === "image_overlay";
  const lower = structuredClone(wire.clips[2]!);
  Object.assign(lower, {
    start_frame: 0,
    duration_frames: 48,
    opacity_bp: 10000,
    blend: "normal",
  });
  Object.assign(lower.transform, {
    position_x_bp: 0,
    position_y_bp: 0,
    scale_x_bp: 10000,
    scale_y_bp: 10000,
    rotation_mdeg: 0,
  });
  const incoming = structuredClone(lower);
  Object.assign(incoming, {
    clip_id: "clip-wipe",
    asset_id: "img-wipe",
    track_id: "track-wipe",
    start_frame: 12,
    duration_frames: 12,
    opacity_bp: 5000,
    transition: { kind, duration_frames: 6 },
  });
  incoming.transform.rotation_mdeg = rotated ? 90000 : 0;
  // An identity colour adjustment requires the real filter capability probe. With no owned
  // parent for its filter host, the detached canvas must take the genuine software fallback.
  incoming.effect.kind = "color_adjust_v1";
  wire.assets.push({
    ...structuredClone(wire.assets[2]!),
    asset_id: "img-wipe",
  });
  wire.tracks.push({
    track_id: "track-wipe",
    kind: "image_overlay",
    order: 4,
    enabled: true,
    locked: false,
  });
  wire.clips = [lower, incoming];
  wire.public_fingerprint = publicCompositionFingerprint(wire);
  const snapshot = decodePublicCompositionSnapshot(wire);
  const parent = document.createElement("div");
  const canvas = document.createElement("canvas");
  if (native) {
    parent.append(canvas);
    document.body.append(parent);
  }
  const compositor = createVisualCompositor(canvas, snapshot, {
    cssWidth: previewSize,
    cssHeight: previewSize,
    devicePixelRatio: 1,
  });
  const blue = await solid(outputSize, outputSize, [0, 0, 255, 255]);
  const red = await solid(sourceWidth, sourceHeight, [255, 0, 0, 128]);
  const resources = new Map([
    [
      lower.clip_id,
      {
        kind: "image" as const,
        source: blue,
        nativeWidth: outputSize,
        nativeHeight: outputSize,
      },
    ],
    [
      incoming.clip_id,
      {
        kind: "image" as const,
        source: red,
        nativeWidth: sourceWidth,
        nativeHeight: sourceHeight,
      },
    ],
  ]);
  const frames = [];
  try {
    // Scrubbing backward reuses the same context and must not inherit an earlier clip path.
    for (const [index, elapsed] of [0, 2, 5, 6, 5, 2, 0].entries()) {
      const receipt = compositor.render(
        decodeResolvedScene(resolveCompositionScene(snapshot, 12 + elapsed)),
        resources,
        index + 1,
      );
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let mismatches = 0,
        maxError = 0,
        revealed = 0;
      // Independent inverse quarter turn, pixel centres and half-alpha source over blue.
      const scale = previewSize / outputSize;
      for (let y = 0; y < previewSize; y += 1)
        for (let x = 0; x < previewSize; x += 1) {
          const dx = (x + 0.5 - previewSize / 2) / scale,
            dy = (y + 0.5 - previewSize / 2) / scale;
          const sx = (rotated ? dy : dx) + sourceWidth / 2,
            sy = (rotated ? -dx : dy) + sourceHeight / 2;
          const inside =
            sx >= 0 && sx < sourceWidth && sy >= 0 && sy < sourceHeight;
          const visible =
            inside &&
            (kind === "cross_dissolve_v1" ||
              {
                wipe_from_left_v1: sx < Math.floor((sourceWidth * elapsed) / 6),
                wipe_from_right_v1:
                  sx >= sourceWidth - Math.floor((sourceWidth * elapsed) / 6),
                wipe_from_top_v1: sy < Math.floor((sourceHeight * elapsed) / 6),
                wipe_from_bottom_v1:
                  sy >= sourceHeight - Math.floor((sourceHeight * elapsed) / 6),
              }[kind]);
          if (visible) revealed += 1;
          const red =
            kind === "cross_dissolve_v1" ? 64 * Math.min(elapsed / 6, 1) : 64;
          const expected = visible
            ? [red, 0, 255 - red, 255]
            : [0, 0, 255, 255];
          const offset = (y * previewSize + x) * 4;
          const error = Math.max(
            ...expected.map((value, channel) =>
              Math.abs(value - pixels[offset + channel]!),
            ),
          );
          maxError = Math.max(maxError, error);
          if (error > 1) mismatches += 1;
        }
      frames.push({
        elapsed,
        receipt: receipt.status,
        mismatches,
        maxError,
        revealed,
      });
    }
    return {
      path: compositor.path(),
      width: canvas.width,
      height: canvas.height,
      frames,
    };
  } finally {
    compositor.close();
    blue.close();
    red.close();
    parent.remove();
  }
}

/** Real text/background painting, compared with an unmasked reference and an independent mask. */
export async function observeTextWipe(
  kind: WipeKind,
  native: boolean,
  rotated: boolean,
) {
  await document.fonts.ready;
  const wire = structuredClone(fixture.snapshot);
  wire.output.width = wire.output.height = 128;
  for (const track of wire.tracks)
    track.enabled = ["image_overlay", "text_overlay"].includes(track.kind);
  const lower = structuredClone(wire.clips[2]!);
  Object.assign(lower, {
    start_frame: 0,
    duration_frames: 48,
    opacity_bp: 10000,
    blend: "normal",
  });
  Object.assign(lower.transform, {
    position_x_bp: 0,
    position_y_bp: 0,
    scale_x_bp: 10000,
    scale_y_bp: 10000,
    rotation_mdeg: 0,
  });
  const title = structuredClone(wire.clips[3]!);
  Object.assign(title, {
    start_frame: 12,
    duration_frames: 12,
    opacity_bp: 5000,
    blend: "normal",
    transition: { kind, duration_frames: 6 },
  });
  Object.assign(title.transform, {
    position_x_bp: 0,
    position_y_bp: 0,
    scale_x_bp: 10000,
    scale_y_bp: 10000,
    rotation_mdeg: rotated ? 90000 : 0,
  });
  Object.assign(title.text!, {
    font_asset_id: "h3.font.noto_sans.v1",
    content: Array(6).fill("MMMMMM").join("\n"),
    size_px: 20,
    line_height_bp: 10000,
    fill_rgba: [255, 0, 0, 128],
    background_rgba: [255, 0, 0, 128],
  });
  title.effect.kind = "color_adjust_v1";
  wire.assets[3]!.asset_id = "h3.font.noto_sans.v1";
  wire.clips = [lower, title];
  wire.public_fingerprint = publicCompositionFingerprint(wire);
  const snapshot = decodePublicCompositionSnapshot(wire);
  const parent = document.createElement("div");
  const canvas = document.createElement("canvas");
  if (native) {
    parent.append(canvas);
    document.body.append(parent);
  }
  const compositor = createVisualCompositor(canvas, snapshot, {
    cssWidth: 128,
    cssHeight: 128,
    devicePixelRatio: 1,
  });
  const blue = await solid(128, 128, [0, 0, 255, 255]);
  const resources = new Map<
    string,
    import("../src/runtime/visualCompositor").VisualLayerResource
  >([
    [
      lower.clip_id,
      { kind: "image", source: blue, nativeWidth: 128, nativeHeight: 128 },
    ],
    [title.clip_id, { kind: "font", family: "sans-serif" }],
  ]);
  try {
    const fullReceipt = compositor.render(
      decodeResolvedScene(resolveCompositionScene(snapshot, 18)),
      resources,
      1,
    );
    const context = canvas.getContext("2d")!;
    const reference = context.getImageData(0, 0, 128, 128).data;
    let inkPixels = 0;
    for (let offset = 0; offset < reference.length; offset += 4)
      if (reference[offset]! > 1) inkPixels += 1;
    const frames = [];
    for (const [index, elapsed] of [0, 2, 5, 6, 5, 2, 0].entries()) {
      const receipt = compositor.render(
        decodeResolvedScene(resolveCompositionScene(snapshot, 12 + elapsed)),
        resources,
        index + 2,
      );
      const pixels = context.getImageData(0, 0, 128, 128).data;
      let mismatches = 0,
        maxError = 0,
        visibleInk = 0;
      for (let y = 0; y < 128; y += 1)
        for (let x = 0; x < 128; x += 1) {
          const dx = x + 0.5 - 64,
            dy = y + 0.5 - 64;
          const sx = (rotated ? dy : dx) + 64,
            sy = (rotated ? -dx : dy) + 64;
          const extent = Math.floor((128 * elapsed) / 6);
          const revealed = {
            wipe_from_left_v1: sx < extent,
            wipe_from_right_v1: sx >= 128 - extent,
            wipe_from_top_v1: sy < extent,
            wipe_from_bottom_v1: sy >= 128 - extent,
          }[kind];
          const offset = (y * 128 + x) * 4;
          if (revealed && reference[offset]! > 1) visibleInk += 1;
          for (let channel = 0; channel < 4; channel += 1) {
            const expected = revealed
              ? reference[offset + channel]!
              : [0, 0, 255, 255][channel]!;
            const error = Math.abs(expected - pixels[offset + channel]!);
            maxError = Math.max(maxError, error);
            if (error > 1) mismatches += 1;
          }
        }
      frames.push({
        elapsed,
        receipt: receipt.status,
        mismatches,
        maxError,
        visibleInk,
      });
    }
    return {
      path: compositor.path(),
      width: canvas.width,
      height: canvas.height,
      fullReceipt: fullReceipt.status,
      inkPixels,
      frames,
    };
  } finally {
    compositor.close();
    blue.close();
    parent.remove();
  }
}

declare global {
  interface Window {
    observeWipe: typeof observeWipe;
    observeTextWipe: typeof observeTextWipe;
  }
}
window.observeWipe = observeWipe;
window.observeTextWipe = observeTextWipe;
