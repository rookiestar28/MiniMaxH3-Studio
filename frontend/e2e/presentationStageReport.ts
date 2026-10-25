/** Closed numeric job-log summaries of the test-only failure attachments. */
const STAGES = [
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
type Stage = (typeof STAGES)[number];
type Event = { navigation: number; stage: Stage; atMs: number };
const invalid = (): never => {
  throw new Error("invalid bounded stage summary input");
};

function closed(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  const own = Reflect.ownKeys(value as object);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    invalid();
  return value as Record<string, unknown>;
}
function number(value: unknown, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer ? !Number.isSafeInteger(value) : value > 3_600_000)
  )
    invalid();
  return value as number;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value as unknown[];
}
const rounded = (value: number, scale = 10) =>
  Math.round(value * scale) / scale;

function navigationSummary(value: unknown) {
  const trace = closed(value, [
    "version",
    "eventsDropped",
    "callbackCount",
    "events",
    "snapshots",
  ]);
  if (trace.version !== 1) invalid();
  const eventsDropped = number(trace.eventsDropped, true);
  const callbackCount = number(trace.callbackCount, true);
  const snapshots = list(trace.snapshots, 4096).map((raw) => {
    const snapshot = closed(raw, ["atMs", "durationMs"]);
    return {
      atMs: number(snapshot.atMs),
      durationMs: number(snapshot.durationMs),
    };
  });
  const grouped = new Map<number, Event[]>();
  for (const raw of list(trace.events, 20_000)) {
    const event = closed(raw, ["navigation", "stage", "atMs"]);
    const navigation = number(event.navigation, true);
    if (navigation === 0 || !STAGES.includes(event.stage as Stage)) invalid();
    const normalized = {
      navigation,
      stage: event.stage as Stage,
      atMs: number(event.atMs),
    };
    const group = grouped.get(navigation) ?? [];
    group.push(normalized);
    grouped.set(navigation, group);
  }
  const ranked: { span: number; row: Record<string, number | null> }[] = [];
  for (const [navigation, events] of grouped) {
    events.sort((left, right) => left.atMs - right.atMs);
    const origin = events.find((event) => event.stage === "keydown")?.atMs;
    let paint: number | undefined;
    let best: { start: number; delivered: number; span: number } | undefined;
    // IMPORTANT: one navigation can paint several times. Rank its largest matching
    // paint/delivered pair, never its first paint against an unrelated later delivery.
    for (const event of events) {
      if (event.stage === "paint-start") paint = event.atMs;
      if (event.stage === "delivered" && paint !== undefined) {
        const span = event.atMs - paint;
        if (best === undefined || span > best.span)
          best = { start: paint, delivered: event.atMs, span };
        paint = undefined;
      }
    }
    if (best === undefined) continue;
    if (origin === undefined || best.start < origin)
      throw new Error("navigation stage origin is unavailable");
    const completed = best;
    const reversed = [...events].reverse();
    const row: Record<string, number | null> = { navigation };
    for (const stage of STAGES) {
      const at =
        stage === "keydown"
          ? origin
          : stage === "paint-start"
            ? best.start
            : stage === "delivered"
              ? best.delivered
              : reversed.find(
                  (event) =>
                    event.stage === stage &&
                    event.atMs >=
                      (stage === "paint-end" ? completed.start : origin) &&
                    event.atMs <= completed.delivered,
                )?.atMs;
      row[stage] = at === undefined ? null : rounded(at - origin);
    }
    const overlapping = snapshots.filter(
      (snapshot) =>
        snapshot.atMs <= best.delivered &&
        snapshot.atMs + snapshot.durationMs >= origin,
    );
    row.snapshotCount = overlapping.length;
    row.snapshotDurationMs = rounded(
      overlapping.reduce((sum, snapshot) => sum + snapshot.durationMs, 0),
    );
    ranked.push({ span: best.span, row });
  }
  if (ranked.length === 0) invalid();
  ranked.sort(
    (left, right) =>
      right.span - left.span || left.row.navigation! - right.row.navigation!,
  );
  return {
    entries: ranked.slice(0, 5).map(({ row }) => row),
    eventsDropped,
    callbackCount,
  };
}

function continuousSummary(value: unknown) {
  const trace = closed(value, [
    "version",
    "windows",
    "samplerIntervalsMs",
    "samplerIntervalsDropped",
  ]);
  if (trace.version !== 1) invalid();
  const rawWindows = list(trace.windows, 3);
  if (rawWindows.length !== 3) invalid();
  const bounds = [
    [4, 43],
    [52, 91],
    [100, 139],
  ] as const;
  const windows = rawWindows.map((raw, index) => {
    const window = closed(raw, ["index", "frames"]);
    if (window.index !== index) invalid();
    const [first, last] = bounds[index]!;
    const frames = list(window.frames, 40)
      .map((rawFrame) => {
        const frame = closed(rawFrame, ["frame", "atMs"]);
        const id = number(frame.frame, true);
        if (id < first || id > last) invalid();
        return { frame: id, atMs: number(frame.atMs) };
      })
      .sort((left, right) => left.frame - right.frame);
    const gaps = frames.slice(1).map((frame, offset) => {
      const previous = frames[offset]!;
      if (previous.frame >= frame.frame || previous.atMs >= frame.atMs)
        invalid();
      return frame.atMs - previous.atMs;
    });
    const firstTime = frames.find((frame) => frame.frame === first)?.atMs;
    const lastTime = frames.find((frame) => frame.frame === last)?.atMs;
    return {
      index,
      observedFrameCount: frames.length,
      maximumGapMs: gaps.length === 0 ? null : rounded(Math.max(...gaps)),
      ratio:
        firstTime === undefined ||
        lastTime === undefined ||
        lastTime <= firstTime
          ? null
          : rounded(
              ((last - first) * 1000) / 24 / (lastTime - firstTime),
              1_000_000,
            ),
    };
  });
  const intervals = list(trace.samplerIntervalsMs, 20_000)
    .map((interval) => number(interval))
    .sort((left, right) => left - right);
  return {
    windows,
    sampler: {
      intervalCount: intervals.length,
      maximumMs: intervals.length === 0 ? null : rounded(intervals.at(-1)!),
      p95Ms:
        intervals.length === 0
          ? null
          : rounded(intervals[Math.ceil(intervals.length * 0.95) - 1]!),
      intervalsDropped: number(trace.samplerIntervalsDropped, true),
    },
  };
}

export function buildPresentationStageReport(
  kind: "navigation" | "continuous",
  value: unknown,
): string {
  // CRITICAL: public job logs must never stringify the raw diagnostic input. Closed
  // validation and a fresh numeric projection keep paths/content and extra fields out.
  const report =
    kind === "navigation"
      ? { navigationStageTopFive: navigationSummary(value) }
      : kind === "continuous"
        ? { continuousStageSummary: continuousSummary(value) }
        : invalid();
  const finiteLeaves = (value: unknown): void => {
    if (value === null) return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid();
    } else if (Array.isArray(value)) value.forEach(finiteLeaves);
    else if (typeof value === "object")
      Object.values(value as object).forEach(finiteLeaves);
    else invalid();
  };
  finiteLeaves(report);
  const line = JSON.stringify(report);
  if (new TextEncoder().encode(line).byteLength > 2048) invalid();
  return line;
}
