import { describe, expect, it } from "vitest";
import { buildPresentationStageReport } from "../e2e/presentationStageReport";

const stages = [
  "keydown",
  "seek-request",
  "runtime-seek",
  "video-seeking",
  "video-seeked",
  "native-frame",
  "paint-start",
  "paint-end",
  "delivered",
] as const;
const navigationTrace = () => ({
  version: 1,
  eventsDropped: 0,
  callbackCount: 50,
  events: [
    { navigation: 1, stage: "keydown", atMs: 10 },
    { navigation: 1, stage: "seek-request", atMs: 10.26 },
    { navigation: 1, stage: "paint-start", atMs: 12 },
    { navigation: 1, stage: "paint-end", atMs: 13 },
    { navigation: 1, stage: "delivered", atMs: 16 },
    { navigation: 1, stage: "paint-start", atMs: 20 },
    { navigation: 1, stage: "paint-end", atMs: 22 },
    { navigation: 1, stage: "delivered", atMs: 35 },
  ],
  snapshots: [
    { atMs: 9, durationMs: 2 },
    { atMs: 30, durationMs: 8 },
    { atMs: 36, durationMs: 1 },
  ],
});
const continuousTrace = () => ({
  version: 1,
  windows: [
    [4, 43],
    [52, 91],
    [100, 139],
  ].map(([first, last], index) => ({
    index,
    frames: [
      { frame: first!, atMs: (first! * 1000) / 24 },
      { frame: last!, atMs: (last! * 1000) / 24 },
    ],
  })),
  samplerIntervalsMs: [2, 10, 20, 30, 40],
  samplerIntervalsDropped: 0,
});

describe("closed pass-path stage reports", () => {
  it("selects the largest paint-to-delivered pair, rounds offsets and counts overlapping snapshots", () => {
    const line = buildPresentationStageReport("navigation", navigationTrace());
    const summary = JSON.parse(line).navigationStageTopFive;
    expect(summary.eventsDropped).toBe(0);
    expect(summary.callbackCount).toBe(50);
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toEqual({
      navigation: 1,
      keydown: 0,
      "seek-request": 0.3,
      "runtime-seek": null,
      "video-seeking": null,
      "video-seeked": null,
      "native-frame": null,
      "paint-start": 10,
      "paint-end": 12,
      delivered: 25,
      snapshotCount: 2,
      snapshotDurationMs: 10,
    });
  });

  it("orders the five distinct navigation indices by their largest paint-to-delivered span", () => {
    const trace = navigationTrace();
    trace.snapshots = [];
    trace.events = Array.from({ length: 7 }, (_, index) => [
      { navigation: index + 1, stage: "keydown", atMs: index * 100 },
      { navigation: index + 1, stage: "paint-start", atMs: index * 100 + 1 },
      {
        navigation: index + 1,
        stage: "delivered",
        atMs: index * 100 + index + 2,
      },
    ]).flat();
    const summary = JSON.parse(
      buildPresentationStageReport("navigation", trace),
    ).navigationStageTopFive;
    expect(
      summary.entries.map((entry: { navigation: number }) => entry.navigation),
    ).toEqual([7, 6, 5, 4, 3]);
    for (const entry of summary.entries)
      for (const stage of stages) expect(entry).toHaveProperty(stage);
  });

  it("reports per-window observed frames, gaps and ratio plus sampler nearest-rank p95", () => {
    const summary = JSON.parse(
      buildPresentationStageReport("continuous", continuousTrace()),
    ).continuousStageSummary;
    expect(summary.windows).toEqual(
      [0, 1, 2].map((index) => ({
        index,
        observedFrameCount: 2,
        maximumGapMs: 1625,
        ratio: 1,
      })),
    );
    expect(summary.sampler).toEqual({
      intervalCount: 5,
      maximumMs: 40,
      p95Ms: 40,
      intervalsDropped: 0,
    });
  });

  it("uses null when a window lacks an endpoint or the sampler has no intervals", () => {
    const trace = continuousTrace();
    trace.windows[0]!.frames.pop();
    trace.samplerIntervalsMs = [];
    const summary = JSON.parse(
      buildPresentationStageReport("continuous", trace),
    ).continuousStageSummary;
    expect(summary.windows[0]).toEqual({
      index: 0,
      observedFrameCount: 1,
      maximumGapMs: null,
      ratio: null,
    });
    expect(summary.sampler).toEqual({
      intervalCount: 0,
      maximumMs: null,
      p95Ms: null,
      intervalsDropped: 0,
    });
  });

  it.each(["navigation", "continuous"] as const)(
    "allows only fixed keys and numeric/null leaves, in at most 2 KB: %s",
    (kind) => {
      const allowed = new Set([
        ...stages,
        "navigationStageTopFive",
        "continuousStageSummary",
        "entries",
        "eventsDropped",
        "callbackCount",
        "navigation",
        "snapshotCount",
        "snapshotDurationMs",
        "windows",
        "index",
        "observedFrameCount",
        "maximumGapMs",
        "ratio",
        "sampler",
        "intervalCount",
        "maximumMs",
        "p95Ms",
        "intervalsDropped",
      ]);
      const line = buildPresentationStageReport(
        kind,
        kind === "navigation" ? navigationTrace() : continuousTrace(),
      );
      const visit = (value: unknown): void => {
        if (
          value === null ||
          (typeof value === "number" && Number.isFinite(value))
        )
          return;
        if (Array.isArray(value)) return value.forEach(visit);
        expect(typeof value).toBe("object");
        for (const [key, child] of Object.entries(value as object)) {
          expect(allowed.has(key)).toBe(true);
          visit(child);
        }
      };
      visit(JSON.parse(line));
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(
        2048,
      );
    },
  );

  it.each([
    (value: ReturnType<typeof navigationTrace>) => {
      value.events[0]!.stage = "private-label";
    },
    (value: ReturnType<typeof navigationTrace>) => {
      value.events[0]!.atMs = Number.NaN;
    },
    (value: ReturnType<typeof navigationTrace>) => {
      value.snapshots[0]!.durationMs = Infinity;
    },
    (value: ReturnType<typeof navigationTrace>) => {
      Object.assign(value, { unknown: 1 });
    },
    (value: ReturnType<typeof navigationTrace>) => {
      Object.assign(value.events[0]!, { unknown: 1 });
    },
    (value: ReturnType<typeof navigationTrace>) => {
      Object.assign(value.snapshots[0]!, { unknown: 1 });
    },
    (value: ReturnType<typeof navigationTrace>) => {
      value.events = Array.from({ length: 20_001 }, () => value.events[0]!);
    },
    (value: ReturnType<typeof navigationTrace>) => {
      value.snapshots = Array.from({ length: 4097 }, () => value.snapshots[0]!);
    },
    (value: ReturnType<typeof navigationTrace>) => {
      value.events[0]!.atMs = Number.MAX_VALUE;
    },
  ])("refuses unbounded or open navigation input %#", (mutate) => {
    const value = navigationTrace();
    mutate(value);
    expect(() => buildPresentationStageReport("navigation", value)).toThrow();
  });

  it.each([
    (value: ReturnType<typeof continuousTrace>) => {
      Object.assign(value.windows[0]!, { unknown: 1 });
    },
    (value: ReturnType<typeof continuousTrace>) => {
      Object.assign(value.windows[0]!.frames[0]!, { unknown: 1 });
    },
    (value: ReturnType<typeof continuousTrace>) => {
      value.samplerIntervalsMs[0] = Infinity;
    },
    (value: ReturnType<typeof continuousTrace>) => {
      value.windows[0]!.frames[0]!.atMs = NaN;
    },
    (value: ReturnType<typeof continuousTrace>) => {
      value.windows[0]!.frames.push(value.windows[0]!.frames[0]!);
    },
    (value: ReturnType<typeof continuousTrace>) => {
      value.samplerIntervalsMs = Array(20_001).fill(1);
    },
    (value: ReturnType<typeof continuousTrace>) => {
      value.windows[0]!.frames[0]!.atMs = 0;
      value.windows[0]!.frames[1]!.atMs = Number.MIN_VALUE;
    },
  ])("refuses unbounded or open continuous input %#", (mutate) => {
    const value = continuousTrace();
    mutate(value);
    expect(() => buildPresentationStageReport("continuous", value)).toThrow();
  });
});
