import { describe, expect, it } from "vitest";

import {
  type AppModeInputs,
  validateInputs,
} from "../src/host/appModeContract";
import {
  hasChosenCanvasMedia,
  preparationReferenceCounts,
  preserveTemplateReferenceMedia,
  resolvePreparationFrames,
  unchosenPreparationRoles,
  validateCanvasPreparationInputs,
} from "../src/host/appModeCanvasPreparation";

const common = {
  user_intent: "Prepare the graph before choosing media.",
  duration_milliseconds: 5167,
  frame_count: 124,
};

describe("canvas preparation media contract", () => {
  it.each(["i2va", "l2va", "fl2va", "ref2va"] as const)(
    "accepts absent %s roles only for preparation",
    (task_mode) => {
      const inputs = { ...common, task_mode };
      expect(() => validateCanvasPreparationInputs(inputs)).not.toThrow();
      expect(() => validateInputs(inputs)).toThrow();
      expect(hasChosenCanvasMedia(inputs)).toBe(false);
    },
  );

  it.each([
    { task_mode: "i2va", first_frame_source: "" },
    { task_mode: "l2va", last_frame_source: "../loader" },
    { task_mode: "fl2va", first_frame_source: "17", last_frame_source: "17" },
    { task_mode: "i2va", last_frame_source: "17" },
    { task_mode: "t2va", first_frame_source: "17" },
    { task_mode: "fl2va", reference_image_sources: ["17"] },
    { task_mode: "ref2va", reference_image_sources: [""] },
    { task_mode: "ref2va", reference_image_sources: ["17", "17"] },
    { task_mode: "ref2va", reference_audio_sources: ["17"] },
    { task_mode: "ref2va", reference_video_soundtrack: "included" },
    {
      task_mode: "ref2va",
      reference_video_sources: ["17"],
      reference_video_soundtrack: "invalid",
    },
  ])("rejects malformed or conflicting selected roles %#", (roles) => {
    expect(() =>
      validateCanvasPreparationInputs({ ...common, ...roles } as AppModeInputs),
    ).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("keeps reference capacity limits even though empty preparation is allowed", () => {
    expect(() =>
      validateCanvasPreparationInputs({
        ...common,
        task_mode: "ref2va",
        reference_image_sources: Array.from({ length: 10 }, (_, index) =>
          String(index + 1),
        ),
      }),
    ).toThrow(expect.objectContaining({ code: "reference_capacity_exceeded" }));
  });

  it.each([
    ["i2va", {}, ["firstFrame"]],
    ["l2va", {}, ["lastFrame"]],
    ["fl2va", {}, ["firstFrame", "lastFrame"]],
    ["fl2va", { first_frame_source: "17" }, ["lastFrame"]],
    ["fl2va", { last_frame_source: "18" }, ["firstFrame"]],
    ["fl2va", { first_frame_source: "17", last_frame_source: "18" }, []],
    ["ref2va", {}, ["referenceImages"]],
    ["ref2va", { reference_video_sources: ["17"] as string[] }, []],
    ["t2va", {}, []],
  ] as const)(
    "derives readiness roles from the %s request only: %j",
    (task_mode, roles, expected) => {
      expect(
        unchosenPreparationRoles({ ...common, task_mode, ...roles }),
      ).toEqual(expected);
    },
  );

  it("qualifies exactly the chosen frame instead of requiring its unchosen counterpart", () => {
    const first = { class_type: "LoadImage", inputs: {} };
    const inputs: AppModeInputs = {
      ...common,
      task_mode: "fl2va",
      first_frame_source: "17",
    };
    expect(() => validateCanvasPreparationInputs(inputs)).not.toThrow();
    expect(resolvePreparationFrames(inputs, first, undefined)).toEqual({
      first_frame: first,
    });
    expect(
      resolvePreparationFrames(inputs, undefined, undefined),
    ).toBeUndefined();
  });

  it("keeps template reference counts only in unselected preparation", () => {
    const inputs: AppModeInputs = { ...common, task_mode: "ref2va" };
    expect(preserveTemplateReferenceMedia(inputs, true)).toBe(true);
    expect(preserveTemplateReferenceMedia(inputs, false)).toBe(false);
    expect(
      preserveTemplateReferenceMedia(
        { ...inputs, reference_video_sources: ["17"] },
        true,
      ),
    ).toBe(false);
    expect(
      preparationReferenceCounts(inputs, {
        referenceImages: [10, 11],
        referenceVideos: [],
        referenceAudios: [],
      }),
    ).toEqual({ images: 2, videos: 0, audios: 0, pairedAudios: 0 });
  });

  it.each([
    [
      { reference_image_sources: ["17", "18"] },
      { images: 2, videos: 0, audios: 0, pairedAudios: 0 },
    ],
    [
      { reference_video_sources: ["17", "18"] },
      { images: 0, videos: 2, audios: 0, pairedAudios: 2 },
    ],
    [
      {
        reference_image_sources: ["17"],
        reference_audio_sources: ["18", "19"],
      },
      { images: 1, videos: 0, audios: 2, pairedAudios: 0 },
    ],
  ])(
    "keeps request-derived counts when preparation has a chosen reference: %j",
    (roles, expected) => {
      const inputs: AppModeInputs = {
        ...common,
        task_mode: "ref2va",
        ...roles,
      };
      expect(() => validateCanvasPreparationInputs(inputs)).not.toThrow();
      expect(
        preparationReferenceCounts(inputs, {
          referenceImages: [],
          referenceVideos: [],
          referenceAudios: [],
        }),
      ).toEqual(expected);
    },
  );
});
