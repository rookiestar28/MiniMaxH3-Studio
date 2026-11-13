import type { TextStyleWire } from "./nleCommandBuilders";
export type TextPresetId =
  | "outline"
  | "outlineYellow"
  | "dropShadow"
  | "outlineShadow"
  | "captionBox"
  | "highlight"
  | "inverseBox"
  | "boldOutline";
export type TextPreset = Readonly<{
  id: TextPresetId;
  style: Pick<
    TextStyleWire,
    | "weight"
    | "style"
    | "fill_rgba"
    | "background_rgba"
    | "stroke"
    | "shadow"
    | "background_padding_px"
  >;
}>;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const white = [255, 255, 255, 255] as const;
const black = [0, 0, 0, 255] as const;
const yellow = [255, 255, 0, 255] as const;
const normal = {
  weight: 400,
  style: "normal",
  fill_rgba: white,
  background_rgba: null,
} as const;
export const TEXT_PRESETS: readonly TextPreset[] = freeze([
  { id: "outline", style: { ...normal, stroke: { rgba: black, width_px: 3 } } },
  {
    id: "outlineYellow",
    style: {
      ...normal,
      fill_rgba: yellow,
      stroke: { rgba: black, width_px: 4 },
    },
  },
  {
    id: "dropShadow",
    style: {
      ...normal,
      shadow: { rgba: [0, 0, 0, 128], offset_x_px: 3, offset_y_px: 3 },
    },
  },
  {
    id: "outlineShadow",
    style: {
      ...normal,
      stroke: { rgba: black, width_px: 3 },
      shadow: { rgba: [0, 0, 0, 128], offset_x_px: 3, offset_y_px: 3 },
    },
  },
  {
    id: "captionBox",
    style: {
      ...normal,
      background_rgba: [0, 0, 0, 153],
      background_padding_px: 8,
    },
  },
  {
    id: "highlight",
    style: {
      ...normal,
      fill_rgba: black,
      background_rgba: yellow,
      background_padding_px: 6,
    },
  },
  {
    id: "inverseBox",
    style: {
      ...normal,
      fill_rgba: black,
      background_rgba: white,
      background_padding_px: 8,
    },
  },
  {
    id: "boldOutline",
    style: {
      ...normal,
      weight: 700,
      stroke: { rgba: black, width_px: 5 },
      shadow: { rgba: [0, 0, 0, 102], offset_x_px: 2, offset_y_px: 2 },
    },
  },
] satisfies TextPreset[]);

export function applyPreset(
  style: TextStyleWire,
  preset: TextPreset,
): TextStyleWire {
  // Replace the complete decoration group: merging leaves an old shadow or padding behind.
  const {
    stroke: _stroke,
    shadow: _shadow,
    background_padding_px: _padding,
    ...base
  } = style;
  return { ...base, ...preset.style };
}
