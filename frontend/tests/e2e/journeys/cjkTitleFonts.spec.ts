import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalWorkspace, snapshot } from "../helpers/nleCanonical";
import { routeGenericFixtureMedia } from "../helpers/genericFixtureMedia";
import { seekPlayhead, playheadSlider } from "../helpers/nleTimeline";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

for (const [region, content] of [
  ["Latin", "Latin Ω Привет"],
  ["TC", "繁體中文"],
  ["SC", "汉语标题"],
  ["JP", "日本語かな"],
  ["KR", "한국어 제목"],
] as const) {
  for (const weight of [400, 700]) {
    test(`bundled ${region} ${weight} preview and italic recovery`, async ({
      page,
    }, info) => {
      await routeGenericFixtureMedia(page);
      const filename = `NotoSans${region === "Latin" ? "" : region}-${weight === 700 ? "Bold" : "Regular"}.${region === "Latin" ? "ttf" : "otf"}`;
      await page.route("**/nle-media/font", (route) =>
        route.fulfill({
          contentType: region === "Latin" ? "font/ttf" : "font/otf",
          body: readFileSync(join(root, "comfyui_h3_context/fonts", filename)),
        }),
      );
      // Observe real browser decoding inside the unchanged product 3,000 ms guard.
      await page.addInitScript(() => {
        const original = FontFace;
        const load = original.prototype.load;
        const times: number[] = [];
        const starts = new WeakMap<FontFace, number>();
        Object.assign(window, { cjkFontLoads: times });
        window.FontFace = new Proxy(original, {
          construct(target, args) {
            const started = performance.now();
            const face = Reflect.construct(target, args) as FontFace;
            starts.set(face, started);
            return face;
          },
        });
        original.prototype.load = async function () {
          const started = starts.get(this) ?? performance.now();
          try {
            return await load.call(this);
          } finally {
            times.push(performance.now() - started);
          }
        };
      });
      const transactions = await canonicalWorkspace(
        page,
        (wire) => {
          const title = (
            wire.clips as Array<{
              track_id: string;
              text: Record<string, unknown> | null;
            }>
          ).find((clip) => clip.text)!;
          for (const track of wire.tracks as Array<{
            track_id: string;
            enabled: boolean;
          }>)
            track.enabled = track.track_id === title.track_id;
          Object.assign(title.text!, {
            content,
            weight,
            style: "normal",
            size_px: 42,
          });
        },
        undefined,
        "&media=1",
      );
      await seekPlayhead(page, playheadSlider(page), 12);
      const canvas = page.locator('[data-h3-nle-canvas="composition"]');
      await expect(canvas).toHaveAttribute("data-h3-nle-presented-frame", "12");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Array.from(document.fonts).filter(
                (face) =>
                  face.family.startsWith("h3_preview_") &&
                  face.status === "loaded",
              ).length,
          ),
        )
        .toBeGreaterThan(0);
      const facts = await page.evaluate(() => ({
        loads: (window as typeof window & { cjkFontLoads: number[] })
          .cjkFontLoads,
        faces: Array.from(document.fonts)
          .filter((face) => face.family.startsWith("h3_preview_"))
          .map((face) => ({
            family: face.family,
            status: face.status,
            weight: face.weight,
            style: face.style,
          })),
      }));
      expect(facts.loads.length).toBeGreaterThan(0);
      expect(Math.max(...facts.loads)).toBeLessThan(3000);
      expect(
        facts.faces.some(
          (face) => face.status === "loaded" && face.weight === String(weight),
        ),
      ).toBe(true);
      const ink = await canvas.evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 64) count++;
        return count;
      });
      expect(ink).toBeGreaterThan(100);
      writeFileSync(
        info.outputPath("font-load.json"),
        JSON.stringify(
          { filename, presentedFrame: 12, inkPixels: ink, ...facts },
          null,
          2,
        ),
      );
      await page
        .locator('[data-h3-nle-area="monitor"]')
        .screenshot({ path: info.outputPath("preview.png") });
      if (region === "Latin") return;
      const title = (await snapshot(page)).timelineSnapshot!.clips.find(
        (clip) => clip.text,
      )!;
      await page
        .locator(
          `[data-h3-nle-clip="${title.clipId}"] [data-h3-nle-control="selection.set"]`,
        )
        .click();
      const inspector = page.locator('[data-h3-nle-area="inspector"]');
      await inspector.locator('[data-h3-nle-property-tab="text"]').click();
      const italic = inspector.getByLabel("Italic", { exact: true });
      const transactionCount = transactions.length;
      await italic.check();
      await expect(inspector.getByRole("alert")).toContainText(
        "Turn off italic",
      );
      await expect(
        inspector.locator('[data-h3-nle-control="text.style"]'),
      ).toBeDisabled();
      expect(transactions).toHaveLength(transactionCount);
      await italic.uncheck();
      await expect(inspector.getByRole("alert")).toHaveCount(0);
    });
  }
}
