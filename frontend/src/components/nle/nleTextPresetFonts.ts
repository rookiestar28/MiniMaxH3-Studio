import regular from "../../../../comfyui_h3_context/fonts/NotoSans-Regular.ttf";
import bold from "../../../../comfyui_h3_context/fonts/NotoSans-Bold.ttf";
import { loadPackagedFace } from "../../runtime/visualCompositionResources";

export type PresetFontOwner = Readonly<{ family: string; close(): void }>;
type Weight = 400 | 700;

export function createTitlePresetFontCache(
  load: (weight: Weight) => Promise<PresetFontOwner>,
) {
  const pending = new Map<Weight, Promise<PresetFontOwner>>();
  const owners = new Set<PresetFontOwner>();
  let closed = false;
  return {
    load(weight: Weight): Promise<PresetFontOwner> {
      if (closed) return Promise.reject(new Error("font owner closed"));
      let result = pending.get(weight);
      if (result === undefined) {
        result = Promise.resolve()
          .then(() => load(weight))
          .then((owner) => {
            // IMPORTANT: page disposal can precede FontFace.load; a late face must be removed
            // instead of resurrecting the page's font owner after cleanup.
            if (closed) {
              owner.close();
              throw new Error("font owner closed");
            }
            owners.add(owner);
            return owner;
          });
        // Keep rejected promises too: remounting a grid must not retry an unavailable face.
        pending.set(weight, result);
      }
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const owner of owners) owner.close();
      owners.clear();
    },
  };
}

let pageFonts: ReturnType<typeof createTitlePresetFontCache> | undefined;
export function getTitlePresetFonts() {
  if (typeof FontFace === "undefined") return null;
  if (pageFonts === undefined) {
    pageFonts = createTitlePresetFontCache(async (weight) => {
      // Library mode embeds these assets; the dev server returns their exact allowed URLs.
      const response = await fetch(weight === 700 ? bold : regular);
      if (!response.ok) throw new Error("packaged font unavailable");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > 12 * 1024 * 1024)
        throw new Error("packaged font unavailable");
      return loadPackagedFace(
        bytes,
        `h3-preset-${crypto.randomUUID()}`,
        String(weight),
        "normal",
      );
    });
    window.addEventListener("pagehide", () => pageFonts?.close(), {
      once: true,
    });
  }
  return pageFonts;
}
