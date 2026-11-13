import { expect, test } from "vitest";

import {
  chooseClipAudioWindow,
  isNearAudioMarker as excludesMarker,
  MARKER_MARGIN,
} from "../e2e/clipAudioWindows";

const WINDOW = 480;
const MARKER = { start: 24_000, end: 24_024 };
const isNearAudioMarker = (start: number) =>
  excludesMarker(start, WINDOW, MARKER);
const envelopesAt = (starts: readonly number[], cut = 0) =>
  starts.map((start) => ({ start_sample: start + cut, sample_count: WINDOW }));
const options = (nominal: number, centre = 24_000, cut = 0) => ({
  nominal,
  centre,
  cut,
  windowSamples: WINDOW,
  marker: MARKER,
  name: "fade_in_1_2",
});
const missing = "the capture has no full window at fade_in_1_2";

test("excludes the shift-zero neighbour ending at the marker", () => {
  expect(isNearAudioMarker(23_520)).toBe(true);
});

test.each([
  [23_392, false],
  [23_393, true],
  [24_152, false],
  [24_151, true],
] as const)("marker margin at start %i excludes %s", (start, excluded) => {
  expect(MARKER_MARGIN).toBe(128);
  expect(isNearAudioMarker(start)).toBe(excluded);
});

test.each([
  { starts: [23_038, 23_518, 23_998, 24_478], nominal: 2, old: 1, chosen: 3 },
  { starts: [23_125, 23_605, 24_085, 24_565], nominal: 1, old: 2, chosen: 0 },
])(
  "replays retained capture alignment $starts",
  ({ starts, nominal, old, chosen }) => {
    expect(isNearAudioMarker(starts[old]!)).toBe(true);
    const result = chooseClipAudioWindow(envelopesAt(starts), options(nominal));
    expect(result.index).toBe(chosen);
    expect(result.clipStartSample).toBe(starts[chosen]);
    expect(result.markerAvoided).toBe(true);
  },
);

test("all capture grid phases have an admissible immediate neighbour", () => {
  for (let phase = 0; phase < WINDOW; phase += 1) {
    const starts = [23_040, 23_520, 24_000, 24_480].map(
      (start) => start + phase,
    );
    const nominal = Math.round((24_000 - WINDOW / 2 - starts[0]!) / WINDOW);
    const result = chooseClipAudioWindow(envelopesAt(starts), options(nominal));
    expect(starts.filter(isNearAudioMarker).length).toBeLessThanOrEqual(2);
    expect(Math.abs(result.index! - nominal)).toBeLessThanOrEqual(1);
    expect(isNearAudioMarker(result.clipStartSample)).toBe(false);
  }
});

test("keeps an admissible nominal window", () => {
  const envelopes = envelopesAt([11_520, 12_000, 12_480]);
  const result = chooseClipAudioWindow(envelopes, options(1, 12_240));
  expect(result.envelope).toBe(envelopes[1]);
  expect(result.index).toBe(1);
  expect(result.markerAvoided).toBe(false);
});

test("chooses the nearer admissible neighbour and preserves left-first ties", () => {
  const envelopes = envelopesAt([23_292, 23_772, 24_252]);
  expect(chooseClipAudioWindow(envelopes, options(1, 24_200)).index).toBe(2);
  expect(chooseClipAudioWindow(envelopes, options(1, 24_012)).index).toBe(0);
});

test("rounds clip-relative samples after subtracting the capture cut", () => {
  const result = chooseClipAudioWindow(
    envelopesAt([23_038, 23_518, 23_998, 24_478], 100.25),
    options(2, 24_000, 100.25),
  );
  expect(result.clipStartSample).toBe(24_478);
});

test("refuses when immediate neighbours are absent or excluded without searching wider", () => {
  expect(() =>
    chooseClipAudioWindow(envelopesAt([23_040, 23_520, 24_000]), options(2)),
  ).toThrow(missing);
});

test("refuses a missing nominal window even when a neighbour exists", () => {
  expect(() =>
    chooseClipAudioWindow(envelopesAt([23_040]), options(1)),
  ).toThrow(missing);
});

test("refuses a chosen window that is not full", () => {
  expect(() =>
    chooseClipAudioWindow(
      [{ start_sample: 12_000, sample_count: WINDOW - 1 }],
      options(0, 12_240),
    ),
  ).toThrow(missing);
});
