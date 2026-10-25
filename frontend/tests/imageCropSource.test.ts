import { describe, expect, it } from "vitest";
import {
  buildCropImageUrl,
  createImageCropSources,
} from "../src/host/imageCropSource";
import type { AppModeInputs } from "../src/host/appModeContract";
import { fixtureBackedAppModeApi } from "./support/hostSeamTestDouble";

const crop = {
  x: 8,
  y: 16,
  w: 320,
  h: 240,
  sourceWidth: 640,
  sourceHeight: 480,
};
const api = fixtureBackedAppModeApi({
  fileURL: (path: string) => `http://localhost${path}`,
});
const inputs = {
  task_mode: "i2va",
  user_intent: "A kite.",
  duration_milliseconds: 5167,
  frame_count: 124,
  first_frame_source: "17",
  image_crops: { "17": crop },
} satisfies AppModeInputs;
const changed = expect.objectContaining({
  code: "invalid_request",
  reason: { kind: "image_crop_stale" },
});

describe("private crop source identity", () => {
  it("uses the same-origin view route with annotated type and no re-encoding", () => {
    const url = new URL(
      buildCropImageUrl(api, "folder/chosen.png [output]", "http://localhost"),
    );
    expect(url.pathname).toBe("/view");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filename: "chosen.png",
      subfolder: "folder",
      type: "output",
    });
  });
  it.each([
    "../chosen.png",
    "/chosen.png",
    "C:/chosen.png",
    "folder/../chosen.png",
  ])("refuses escaping locators %#", (locator) =>
    expect(() => buildCropImageUrl(api, locator, "http://localhost")).toThrow(),
  );
  it("refuses a URL seam redirecting outside this host", () =>
    expect(() =>
      buildCropImageUrl(
        fixtureBackedAppModeApi({
          fileURL: () => "https://elsewhere.invalid/view",
        }),
        "chosen.png",
        "http://localhost",
      ),
    ).toThrow());

  it("checks both the applied file value and decoded dimensions before a write", async () => {
    let locator = "chosen.png";
    let width = 640;
    const sources = createImageCropSources({
      api,
      readGraph: () => ({
        nodes: [{ id: 17, type: "LoadImage", widgets_values: [locator] }],
      }),
      origin: "http://localhost",
      measureSourceImage: async () => ({ width, height: 480 }),
    });
    await sources.open("17");
    sources.apply("17", crop);
    await expect(sources.validate(inputs)).resolves.toBeUndefined();
    locator = "changed.png";
    await expect(sources.validate(inputs)).rejects.toEqual(changed);
    locator = "chosen.png";
    width = 800;
    await expect(sources.validate(inputs)).rejects.toEqual(changed);
    expect(JSON.stringify(inputs)).not.toContain("chosen.png");
  });

  it("refuses a file changed while measuring and never accepts an unremembered rectangle", async () => {
    let locator = "chosen.png";
    let change = false;
    const sources = createImageCropSources({
      api,
      readGraph: () => ({
        nodes: [{ id: 17, type: "LoadImage", widgets_values: [locator] }],
      }),
      origin: "http://localhost",
      measureSourceImage: async () => {
        if (change) locator = "changed.png";
        return { width: 640, height: 480 };
      },
    });
    await expect(sources.validate(inputs)).rejects.toEqual(changed);
    await sources.open("17");
    sources.apply("17", crop);
    change = true;
    await expect(sources.validate(inputs)).rejects.toEqual(changed);
    sources.clear();
    await expect(sources.validate(inputs)).rejects.toEqual(changed);
  });
});
