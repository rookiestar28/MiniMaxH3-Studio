import manifest from "../../../comfyui_h3_context/fonts/font_manifest_v1.json";

// CRITICAL: the bundled manifest defines admitted fonts. A legacy-ID literal here
// would refuse every regional face offered by the title picker.
const packagedFontIds = new Set(
  manifest.font_assets.map((asset) => asset.font_asset_id),
);

export function isPackagedFontAssetId(assetId: string): boolean {
  return packagedFontIds.has(assetId);
}
