import {
  AppModeError,
  type AppModeInputs,
  type AppModeOpaqueSources,
  declaredSoundtrackCount,
  referenceVideoSoundtrackOf,
  serializedIdentifier,
  validateCommonInputs,
} from "./appModeContract";
import { validateImageCrops } from "./imageCropContract";
import { referenceCapacity } from "./referenceSelection";
import type { SpliceMediaIds } from "./templateMaterialization";

/** Preparation writes a reviewable canvas and never submits a prompt. */
export function validateCanvasPreparationInputs(inputs: AppModeInputs): void {
  // CRITICAL: relax missing media only for canvas preparation. The materialize
  // route also queues managed starts; relaxing validateInputs would admit empty queues.
  validateCommonInputs(inputs);
  validateImageCrops(inputs, true);
  const validSource = (value: unknown) =>
    typeof value === "string" && serializedIdentifier.test(value);
  const optionalSource = (value: unknown) =>
    value === undefined || validSource(value);
  const validSources = (value: unknown) =>
    value === undefined ||
    (Array.isArray(value) &&
      value.every(validSource) &&
      new Set(value).size === value.length);
  const first = inputs.first_frame_source;
  const last = inputs.last_frame_source;
  const images = inputs.reference_image_sources;
  const videos = inputs.reference_video_sources;
  const audios = inputs.reference_audio_sources;
  const soundtrack = inputs.reference_video_soundtrack;
  if (
    !optionalSource(first) ||
    !optionalSource(last) ||
    (inputs.task_mode === "i2va" && last !== undefined) ||
    (inputs.task_mode === "l2va" && first !== undefined) ||
    (inputs.task_mode === "fl2va" && first !== undefined && first === last) ||
    ((inputs.task_mode === "t2va" || inputs.task_mode === "ref2va") &&
      (first !== undefined || last !== undefined)) ||
    (inputs.task_mode !== "ref2va" &&
      (images !== undefined || videos !== undefined || audios !== undefined)) ||
    !validSources(images) ||
    !validSources(videos) ||
    !validSources(audios) ||
    (soundtrack !== undefined &&
      (inputs.task_mode !== "ref2va" ||
        (videos?.length ?? 0) === 0 ||
        !["included", "excluded", "unavailable"].includes(soundtrack)))
  )
    throw new AppModeError(
      "invalid_request",
      "the selected mode requires exact visible source roles and bounded cardinality",
    );
  const capacity = referenceCapacity({
    images: images?.length ?? 0,
    videos: videos?.length ?? 0,
    audios: audios?.length ?? 0,
    soundtrack: referenceVideoSoundtrackOf(inputs),
  });
  if (
    inputs.task_mode === "ref2va" &&
    (!capacity.capacityAllowed ||
      (hasChosenCanvasMedia(inputs) && !capacity.allowed))
  )
    throw new AppModeError(
      capacity.reason === "visual"
        ? "invalid_request"
        : "reference_capacity_exceeded",
      capacity.reason === "visual"
        ? "select at least one image or video reference"
        : "the reference selection exceeds the file or audio limits",
    );
}

export function hasChosenCanvasMedia(inputs: AppModeInputs): boolean {
  return (
    inputs.first_frame_source !== undefined ||
    inputs.last_frame_source !== undefined ||
    (inputs.reference_image_sources?.length ?? 0) > 0 ||
    (inputs.reference_video_sources?.length ?? 0) > 0 ||
    (inputs.reference_audio_sources?.length ?? 0) > 0
  );
}

export function preserveTemplateReferenceMedia(
  inputs: AppModeInputs,
  canvasOnly: boolean,
): boolean {
  // IMPORTANT: materialize also queues. Only preparation with no selection keeps
  // the template counts; empty arrays otherwise deliberately remove that kind.
  return (
    canvasOnly && inputs.task_mode === "ref2va" && !hasChosenCanvasMedia(inputs)
  );
}

export function unresolvedFrameMedia(
  inputs: AppModeInputs,
  first: unknown,
  last: unknown,
  canvasOnly: boolean,
): boolean {
  // IMPORTANT: an omitted role may keep its template sample. A chosen id that
  // no longer resolves must fail instead of silently substituting that sample.
  const missingFirst =
    first === undefined &&
    (!canvasOnly || inputs.first_frame_source !== undefined);
  const missingLast =
    last === undefined &&
    (!canvasOnly || inputs.last_frame_source !== undefined);
  return (
    (inputs.task_mode === "i2va" && missingFirst) ||
    (inputs.task_mode === "l2va" && missingLast) ||
    (inputs.task_mode === "fl2va" && (missingFirst || missingLast))
  );
}

export function resolvePreparationFrames(
  inputs: AppModeInputs,
  first: Record<string, unknown> | undefined,
  last: Record<string, unknown> | undefined,
): AppModeOpaqueSources | undefined {
  // IMPORTANT: only the preparation flag permits absent roles; materialize also
  // queues managed starts. A chosen loader still has to resolve exactly.
  if (unresolvedFrameMedia(inputs, first, last, true)) return undefined;
  return {
    ...(first === undefined ? {} : { first_frame: first }),
    ...(last === undefined ? {} : { last_frame: last }),
  };
}

export type UnchosenPreparationRole =
  "firstFrame" | "lastFrame" | "referenceImages";

export function unchosenPreparationRoles(
  inputs: AppModeInputs,
): readonly UnchosenPreparationRole[] {
  if (inputs.task_mode === "ref2va")
    return hasChosenCanvasMedia(inputs) ? [] : ["referenceImages"];
  const roles: UnchosenPreparationRole[] = [];
  if (
    (inputs.task_mode === "i2va" || inputs.task_mode === "fl2va") &&
    inputs.first_frame_source === undefined
  )
    roles.push("firstFrame");
  if (
    (inputs.task_mode === "l2va" || inputs.task_mode === "fl2va") &&
    inputs.last_frame_source === undefined
  )
    roles.push("lastFrame");
  return roles;
}

export function preparationReferenceCounts(
  inputs: AppModeInputs,
  ids: SpliceMediaIds | undefined,
) {
  // CRITICAL: only unselected preparation uses template counts. Selected media
  // must keep request counts so a dropped reference cannot pass compilation;
  // materialize also queues managed starts and stays strict there.
  if (hasChosenCanvasMedia(inputs))
    return {
      images: inputs.reference_image_sources?.length ?? 0,
      videos: inputs.reference_video_sources?.length ?? 0,
      audios: inputs.reference_audio_sources?.length ?? 0,
      pairedAudios: declaredSoundtrackCount(inputs),
    };
  return {
    images: ids?.referenceImages.length ?? 0,
    videos: ids?.referenceVideos.length ?? 0,
    audios: ids?.referenceAudios.length ?? 0,
    pairedAudios: declaredSoundtrackCount(inputs),
  };
}
