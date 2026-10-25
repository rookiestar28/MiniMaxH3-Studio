import manifest from "../../../../comfyui_h3_context/fonts/font_manifest_v1.json";
import type { TextStyleWire } from "./nleCommandBuilders";

/** Match the packaged reader's exact face/fallback coverage, never browser/system fonts. */
export function titleTextCovered(
  text: string,
  style: Pick<TextStyleWire, "font_asset_id" | "weight" | "style">,
): boolean {
  if (!text || !manifest.fallback_order.includes(style.font_asset_id))
    return false;
  const face = (id: string) =>
    manifest.font_assets
      .find((asset) => asset.font_asset_id === id)
      ?.faces.find(
        (face) => face.weight === style.weight && face.style === style.style,
      );
  const primary = face(style.font_asset_id);
  if (!primary) return false;
  const candidates = [
    primary,
    ...manifest.fallback_order
      .filter((id) => id !== style.font_asset_id)
      .map(face),
  ];
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const profile = manifest.coverage_profiles.find(
      (row) => row.profile_id === candidate.coverage_profile_id,
    );
    return (
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
    );
  });
}
