import { describe, expect, it } from "vitest";

import {
  type AppModeInputs,
  appModeArtifactPrefix,
  validateConnectInputs,
  validateExistingInputs,
  validateInputs,
} from "../src/host/appModeContract";
import { validateCanvasPreparationInputs } from "../src/host/appModeCanvasPreparation";

const crop = {
  x: 8,
  y: 16,
  w: 320,
  h: 240,
  sourceWidth: 640,
  sourceHeight: 480,
};
const common = {
  task_mode: "i2va",
  user_intent: "A red kite crosses the sky.",
  duration_milliseconds: 5167,
  frame_count: 124,
  first_frame_source: "17",
} as const;
const request = (value: unknown = { "17": crop }): AppModeInputs =>
  ({ ...common, image_crops: value }) as AppModeInputs;
const invalid = expect.objectContaining({ code: "invalid_request" });

describe("crop requests are preparation-only and contain bounded numbers", () => {
  it.each([
    ["managed", validateInputs],
    ["existing", validateExistingInputs],
    ["connect", validateConnectInputs],
  ] as const)("refuses crop-bearing queue requests at %s", (name, validate) => {
    const inputs = request();
    if (name === "connect") delete inputs.first_frame_source;
    expect(() => validate(inputs)).toThrow(
      expect.objectContaining({
        code: "invalid_request",
        reason: { kind: "image_crop_invalid" },
      }),
    );
  });

  it("accepts a crop of a chosen preparation image", () => {
    expect(() => validateCanvasPreparationInputs(request())).not.toThrow();
  });

  it.each([
    { "18": crop },
    { "17": { ...crop, x: -1 } },
    { "17": { ...crop, w: 31 } },
    { "17": { ...crop, h: 0 } },
    { "17": { ...crop, y: 0.5 } },
    { "17": { ...crop, w: 641 } },
    { "17": { ...crop, sourceHeight: 16_385 } },
    { "17": { ...crop, sourceWidth: Number.NaN } },
    { "17": { ...crop, file: "forbidden" } },
    { "17": { ...crop, sourceHeight: undefined } },
    [],
    null,
  ])("rejects malformed or unchosen crop %#", (value) => {
    expect(() => validateCanvasPreparationInputs(request(value))).toThrow(
      invalid,
    );
  });

  it("rejects video or audio identities even in a valid reference selection", () => {
    expect(() =>
      validateCanvasPreparationInputs({
        ...request({ "18": crop }),
        task_mode: "ref2va",
        first_frame_source: undefined,
        reference_image_sources: ["17"],
        reference_video_sources: ["18"],
      }),
    ).toThrow(invalid);
  });

  it.each([
    () => ({
      "17": Object.defineProperty({ ...crop }, "file", { value: "forbidden" }),
    }),
    () => Object.defineProperty({ "17": crop }, "18", { value: crop }),
    () => ({
      "17": Object.defineProperty({ ...crop }, "x", {
        get() {
          throw new Error("must not invoke accessor");
        },
        enumerable: true,
      }),
    }),
    () => ({ "17": { ...crop, [Symbol("file")]: "forbidden" } }),
    () => ({ "17": Object.assign(Object.create({ foreign: true }), crop) }),
  ])("refuses hidden, accessor, symbol or inherited fields %#", (make) => {
    expect(() => validateCanvasPreparationInputs(request(make()))).toThrow(
      invalid,
    );
  });

  it("rejects a source reused across frame roles", () => {
    expect(() =>
      validateCanvasPreparationInputs({
        ...request(),
        task_mode: "fl2va",
        last_frame_source: "17",
      }),
    ).toThrow(invalid);
  });

  it("adds crop identity to artifact naming only when crops exist", () => {
    expect(appModeArtifactPrefix(request())).not.toBe(
      appModeArtifactPrefix(common),
    );
    expect(appModeArtifactPrefix(common)).toBe(
      appModeArtifactPrefix({ ...common }),
    );
  });
});
