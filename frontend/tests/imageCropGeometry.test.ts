import { describe, expect, it } from "vitest";
import {
  applyRatio,
  clampCrop,
  fullImageCrop,
  isFullImageCrop,
  moveCrop,
  resizeCrop,
  type CropHandle,
} from "../src/host/imageCropGeometry";
import { isImageCrop } from "../src/host/imageCropContract";

const handles: CropHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const ratios = [
  [1, 1],
  [16, 9],
  [9, 16],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [21, 9],
  [7, 3],
] as const;

describe("source pixel crop geometry", () => {
  it("keeps the 3:2 top-handle center stable through consecutive keyboard shrinks", () => {
    const crop = {
      ...fullImageCrop(2000, 2000),
      x: 100,
      y: 100,
      w: 1200,
      h: 800,
    };
    let next = crop;
    for (let n = 0; n < 8; n++) {
      next = resizeCrop(next, "n", 0, 10, [3, 2], "keyboard");
      expect(Math.abs(next.x + next.w / 2 - 700)).toBeLessThanOrEqual(0.5);
    }
  });
  it.each([1, 10])(
    "grows every fixed-ratio keyboard handle symmetrically for %i-pixel requests",
    (step) => {
      const crop = {
        ...fullImageCrop(3000, 3000),
        x: 500,
        y: 500,
        w: 1120,
        h: 630,
      };
      for (const handle of handles) {
        const dx = handle.includes("w")
          ? -step
          : handle.includes("e")
            ? step
            : 0;
        const dy = handle.includes("n")
          ? -step
          : handle.includes("s")
            ? step
            : 0;
        const grown = resizeCrop(crop, handle, dx, dy, [16, 9], "keyboard");
        expect(grown.w, handle).toBeGreaterThan(crop.w);
        expect(
          resizeCrop(grown, handle, -dx, -dy, [16, 9], "keyboard"),
          handle,
        ).toEqual(crop);
      }
    },
  );
  it.each(["n", "s", "e", "w"] as const)(
    "does not accumulate off-axis rounding for keyboard edge %s",
    (handle) => {
      for (const [p, q] of ratios) {
        for (const k of [400, 401]) {
          const crop = {
            ...fullImageCrop(12000, 12000),
            x: 100,
            y: 100,
            w: p * k,
            h: q * k,
          };
          const horizontal = handle === "e" || handle === "w";
          const dx = handle === "e" ? -10 : handle === "w" ? 10 : 0;
          const dy = handle === "s" ? -10 : handle === "n" ? 10 : 0;
          const center = horizontal ? crop.y + crop.h / 2 : crop.x + crop.w / 2;
          let next = crop;
          for (let n = 0; n < 8; n++) {
            const smaller = resizeCrop(
              next,
              handle,
              dx,
              dy,
              [p, q],
              "keyboard",
            );
            expect(
              resizeCrop(smaller, handle, -dx, -dy, [p, q], "keyboard"),
            ).toEqual(next);
            next = smaller;
            const nextCenter = horizontal
              ? next.y + next.h / 2
              : next.x + next.w / 2;
            expect(
              Math.abs(nextCenter - center),
              `${p}:${q}/${k}/${n}`,
            ).toBeLessThanOrEqual(0.5);
          }
        }
      }
    },
  );
  it("fits one integer multiplier instead of independently rounding each dimension", () => {
    expect(applyRatio(fullImageCrop(1024, 768), 7, 3)).toMatchObject({
      w: 1022,
      h: 438,
    });
    expect(applyRatio(fullImageCrop(1024, 768), 21, 9)).toEqual(
      applyRatio(fullImageCrop(1024, 768), 7, 3),
    );
    expect(applyRatio(fullImageCrop(32, 32), 16, 9)).toBeUndefined();
  });

  it("does not grow past the requested box when resizing an exact ratio", () => {
    const crop = {
      ...fullImageCrop(1400, 1000),
      x: 100,
      y: 100,
      w: 1120,
      h: 630,
    };
    expect(resizeCrop(crop, "e", 9, 0, [16, 9])).toMatchObject({
      x: 100,
      w: 1120,
      h: 630,
    });
  });

  it("preserves odd boundary rectangles and blocks keyboard growth that cannot fit", () => {
    for (const x of [0, 1]) {
      const crop = { ...fullImageCrop(304, 400), x, y: 20, w: 303, h: 202 };
      for (const handle of ["n", "s"] as const) {
        const dy = handle === "n" ? 1 : -1;
        const smaller = resizeCrop(crop, handle, 0, dy, [3, 2], "keyboard");
        expect(resizeCrop(smaller, handle, 0, -dy, [3, 2], "keyboard")).toEqual(
          crop,
        );
        expect(resizeCrop(crop, handle, 0, -dy, [3, 2], "keyboard")).toEqual(
          crop,
        );
      }
    }
  });

  it("clamps movement without changing dimensions and stores full source as no crop", () => {
    const crop = { ...fullImageCrop(640, 480), x: 40, y: 50, w: 320, h: 240 };
    expect(moveCrop(crop, -1000, 1000)).toMatchObject({
      x: 0,
      y: 240,
      w: 320,
      h: 240,
    });
    expect(clampCrop({ ...crop, x: -1.2, y: 99.6, w: 700 })).toMatchObject({
      x: 0,
      y: 100,
      w: 640,
    });
    expect(isFullImageCrop(fullImageCrop(640, 480))).toBe(true);
    expect(isFullImageCrop(crop)).toBe(false);
  });

  it.each(handles)(
    "anchors the opposite edge or corner for free resize %s",
    (handle) => {
      const crop = {
        ...fullImageCrop(640, 480),
        x: 100,
        y: 100,
        w: 200,
        h: 200,
      };
      const next = resizeCrop(crop, handle, 40, 50);
      expect(resizeCrop(crop, handle, 40, 50, undefined, "keyboard")).toEqual(
        next,
      );
      if (handle.includes("w")) expect(next.x + next.w).toBe(300);
      if (handle.includes("e")) expect(next.x).toBe(100);
      if (handle.includes("n")) expect(next.y + next.h).toBe(300);
      if (handle.includes("s")) expect(next.y).toBe(100);
      expect(isImageCrop(next)).toBe(true);
    },
  );

  it.each(ratios)(
    "keeps exact %i:%i through all handles and extreme deltas",
    (p, q) => {
      for (const size of [
        [1024, 768],
        [768, 1024],
        [16384, 16384],
        [64, 64],
      ]) {
        const initial = applyRatio(fullImageCrop(size[0]!, size[1]!), p, q);
        if (initial === undefined) continue;
        for (const input of ["pointer", "keyboard"] as const)
          for (const handle of handles)
            for (const dx of [-20000, -39, 0, 37, 20000])
              for (const dy of [-20000, -41, 0, 43, 20000]) {
                const next = resizeCrop(initial, handle, dx, dy, [p, q], input);
                expect(isImageCrop(next), `${handle}/${dx}/${dy}`).toBe(true);
                expect(next.w * q).toBe(next.h * p);
              }
      }
    },
  );
});
