import manifest from "../../../../comfyui_h3_context/fonts/font_manifest_v1.json";
import type { TextStyleWire } from "./nleCommandBuilders";

/** Match the packaged reader's exact face/fallback coverage, never browser/system fonts. */
export function resolveTitleFont(
  text: string,
  style: Pick<TextStyleWire, "font_asset_id" | "weight" | "style">,
): { artifactId: string; fontAssetId: string } | { reason: string } {
  if (!text) return { reason: "font_glyph_unsupported" };
  if (!manifest.fallback_order.includes(style.font_asset_id))
    return { reason: "font_asset_unsupported" };
  if (
    ![400, 700].includes(style.weight) ||
    !["normal", "italic"].includes(style.style)
  )
    return { reason: "font_style_unsupported" };
  const face = (id: string) =>
    manifest.font_assets
      .find((asset) => asset.font_asset_id === id)
      ?.faces.find(
        (face) => face.weight === style.weight && face.style === style.style,
      );
  // IMPORTANT: regional cmaps overlap. Coverage alone chooses TC for Japanese/Korean;
  // match the backend's script preference to preserve the default regional glyph forms.
  const preferred = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u.test(text)
    ? "h3.font.noto_sans_jp.v1"
    : /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff\uffa0-\uffdc]/u.test(
          text,
        )
      ? "h3.font.noto_sans_kr.v1"
      : null;
  const order = [
    ...new Set([
      style.font_asset_id,
      ...(preferred ? [preferred] : []),
      ...manifest.fallback_order,
    ]),
  ];
  for (const id of order) {
    const candidate = face(id);
    if (!candidate) continue;
    const profile = manifest.coverage_profiles.find(
      (row) => row.profile_id === candidate.coverage_profile_id,
    );
    if (
      !!profile &&
      Array.from(text).every((character) => {
        const point = character.codePointAt(0)!;
        return (
          point === 9 ||
          point === 10 ||
          profile.ranges.some(
            ([start, end]) => point >= start! && point <= end!,
          )
        );
      })
    )
      return { artifactId: candidate.artifact_id, fontAssetId: id };
  }
  if (
    style.style === "italic" &&
    !("reason" in resolveTitleFont(text, { ...style, style: "normal" }))
  )
    return { reason: "font_italic_unsupported" };
  return { reason: "font_glyph_unsupported" };
}

export function titleTextCovered(
  text: string,
  style: Pick<TextStyleWire, "font_asset_id" | "weight" | "style">,
): boolean {
  return !("reason" in resolveTitleFont(text, style));
}

export function titleTextRefusal(
  text: string,
  style: Pick<TextStyleWire, "font_asset_id" | "weight" | "style">,
): "font_glyph_unsupported" | "font_italic_unsupported" {
  const decision = resolveTitleFont(text, style);
  return "reason" in decision && decision.reason === "font_italic_unsupported"
    ? "font_italic_unsupported"
    : "font_glyph_unsupported";
}
