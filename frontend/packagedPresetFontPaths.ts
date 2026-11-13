import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot } from "vite";

export function presetFontAllow(root: string): string[] {
  // IMPORTANT: retain Vite's default boundary and add files, not the font/repository
  // directory; broadening this to a directory would expose unrelated local records.
  return [
    searchForWorkspaceRoot(root),
    fileURLToPath(
      new URL(
        "../comfyui_h3_context/fonts/NotoSans-Regular.ttf",
        import.meta.url,
      ),
    ),
    fileURLToPath(
      new URL("../comfyui_h3_context/fonts/NotoSans-Bold.ttf", import.meta.url),
    ),
  ];
}
