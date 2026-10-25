import type { Page } from "@playwright/test";

import { playheadSlider, seekPlayhead } from "./nleTimeline";

/** Issue the real gesture; presentation is checked by the caller's compositor receipt. */
export async function seekSemanticTransport(
  page: Page,
  frame: number,
  budgetMs: number,
): Promise<number> {
  const slider = playheadSlider(page);
  await slider.waitFor({ state: "visible", timeout: budgetMs });
  // GUARD (D45-02): retain the real gesture's acknowledged, clamped target. A second ruler
  // read can expose the previous presented frame before the target paint arrives and falsely
  // block a correct observation. This receipt is only the request; the caller must still check
  // the compositor's exact frame/fingerprint and read its pixels after that presentation.
  return seekPlayhead(page, slider, frame);
}
