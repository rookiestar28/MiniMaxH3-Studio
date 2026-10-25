import type { Page } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  slider: { waitFor: vi.fn() },
  seekPlayhead: vi.fn(),
  playheadFrame: vi.fn(),
}));

vi.mock("./e2e/helpers/nleTimeline", () => ({
  playheadSlider: () => harness.slider,
  seekPlayhead: harness.seekPlayhead,
  playheadFrame: harness.playheadFrame,
}));

import { seekSemanticTransport } from "./e2e/helpers/nleSemanticTransport";

describe("semantic transport gesture receipt", () => {
  const page = {} as Page;

  beforeEach(() => {
    harness.slider.waitFor.mockResolvedValue(undefined);
  });

  it.each([
    { requested: 6, accepted: 6, projected: 5 },
    { requested: 0, accepted: 0, projected: 47 },
    { requested: 999, accepted: 47, projected: 5 },
  ])(
    "retains accepted frame $accepted while the pre-presentation projection is $projected",
    async ({ requested, accepted, projected }) => {
      // The complete browser sweep observed this exact first sequence: the real gesture
      // acknowledged6, an immediate projection read yielded5, then the compositor delivered6.
      harness.seekPlayhead.mockResolvedValue(accepted);
      harness.playheadFrame.mockResolvedValue(projected);

      await expect(
        seekSemanticTransport(page, requested, 15_000),
      ).resolves.toBe(accepted);
      expect(harness.seekPlayhead).toHaveBeenCalledExactlyOnceWith(
        page,
        harness.slider,
        requested,
      );
      expect(harness.slider.waitFor).toHaveBeenCalledExactlyOnceWith({
        state: "visible",
        timeout: 15_000,
      });
    },
  );

  it("preserves the real gesture failure instead of returning the requested number", async () => {
    const failure = new Error("playhead_target_outside_view:6");
    harness.seekPlayhead.mockRejectedValue(failure);
    await expect(seekSemanticTransport(page, 6, 15_000)).rejects.toBe(failure);
  });

  it("does not seek when the control fails its original visibility bound", async () => {
    const failure = new Error("control_not_visible");
    harness.slider.waitFor.mockRejectedValue(failure);
    await expect(seekSemanticTransport(page, 6, 15_000)).rejects.toBe(failure);
    expect(harness.seekPlayhead).not.toHaveBeenCalled();
  });
});
