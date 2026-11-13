/** Local source observations immediately before one managed preparation. */
import {
  AppModeError,
  throwIfCancelled,
  type AppModeCompiledPrompt,
  type AppModeInputs,
  type AppModeStartOptions,
} from "./appModeContract";
import { buildManagedSourceIdentityRequest } from "./appModeManagedPreparation";
import type { InputGeometryReceipt } from "./inputGeometry";
import {
  observePreparedSequenceMedia,
  type SequenceMediaSourceObservation,
} from "./preparedSequenceObservation";
import type { SpliceMediaIds } from "./templateGraphTopology";

export async function observeManagedAppModeSources(
  inputs: AppModeInputs,
  options: AppModeStartOptions,
  route: "existing" | "replace" | "new",
  original: unknown,
  compiled: AppModeCompiledPrompt,
  ids: SpliceMediaIds | undefined,
  anchorNodeId: number,
  readGraph: () => unknown,
): Promise<
  Readonly<{
    sourceIdentity?: InputGeometryReceipt;
    sequenceSources?: SequenceMediaSourceObservation;
  }>
> {
  const sequence = options.preparedSequenceMedia,
    observe = options.observeSourceIdentity,
    signal = options.signal;
  if (sequence !== undefined) {
    if (
      ids === undefined ||
      (sequence.bindings !== null && observe === undefined)
    )
      throw new AppModeError(
        "sequence_media_changed",
        "reselect the declared frame source and retry the sequence",
      );
    const sequenceSources = await observePreparedSequenceMedia(
      readGraph(),
      compiled,
      ids,
      inputs,
      sequence,
      (request) => observe!(request, signal),
      { anchorNodeId, readGraph },
    );
    throwIfCancelled(signal);
    return { sequenceSources };
  }
  if (inputs.task_mode !== "i2va" || route === "existing") return {};
  try {
    if (observe === undefined || inputs.first_frame_source === undefined)
      throw new AppModeError(
        "incompatible_seam",
        "source identity observation is unavailable; keep the canvas and use native nodes",
      );
    const sourceIdentity = await observe(
      buildManagedSourceIdentityRequest(original, inputs.first_frame_source),
      signal,
    );
    throwIfCancelled(signal);
    return { sourceIdentity };
  } catch (error) {
    if (signal?.aborted)
      throw new AppModeError(
        "cancelled",
        "App Mode was cancelled before source identity was accepted",
      );
    if (error instanceof AppModeError) throw error;
    throw new AppModeError(
      "incompatible_seam",
      "source identity could not be observed safely; reselect the image or use native nodes",
    );
  }
}
