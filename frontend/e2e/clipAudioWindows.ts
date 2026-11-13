export const MARKER_MARGIN = 128;

interface AudioMarker {
  readonly start: number;
  readonly end: number;
}

interface AudioWindow {
  readonly start_sample: number;
  readonly sample_count: number;
}

export function isNearAudioMarker(
  start: number,
  windowSamples: number,
  marker: AudioMarker,
): boolean {
  // GUARD: keep measured preview windows at least one render quantum from the marker.
  // An overlap-only check admits a window ending at the marker, where preview energy bleeds in.
  return (
    start < marker.end + MARKER_MARGIN &&
    start + windowSamples > marker.start - MARKER_MARGIN
  );
}

export function chooseClipAudioWindow<T extends AudioWindow>(
  envelopes: readonly T[],
  {
    nominal,
    centre,
    cut,
    windowSamples,
    marker,
    name,
  }: {
    nominal: number;
    centre: number;
    cut: number;
    windowSamples: number;
    marker: AudioMarker;
    name: string;
  },
) {
  const missing = () => new Error(`the capture has no full window at ${name}`);
  if (envelopes[nominal] === undefined) throw missing();
  const clipStartOf = (index: number) =>
    Math.round(envelopes[index]!.start_sample - cut);
  const excluded = (index: number) =>
    isNearAudioMarker(clipStartOf(index), windowSamples, marker);
  const index = !excluded(nominal)
    ? nominal
    : [nominal - 1, nominal + 1]
        .filter(
          (candidate) =>
            envelopes[candidate] !== undefined && !excluded(candidate),
        )
        .sort(
          (left, right) =>
            Math.abs(clipStartOf(left) + windowSamples / 2 - centre) -
            Math.abs(clipStartOf(right) + windowSamples / 2 - centre),
        )[0];
  const envelope = index === undefined ? undefined : envelopes[index];
  if (envelope === undefined || envelope.sample_count !== windowSamples)
    throw missing();
  return {
    envelope,
    index,
    clipStartSample: Math.round(envelope.start_sample - cut),
    markerAvoided: index !== nominal,
  };
}
