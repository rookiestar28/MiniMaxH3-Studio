import { test, type Page, type Request } from "@playwright/test";

import { nleCopy } from "../../../src/components/nle/nleCopy";

/**
 * Closed facts about the integrated shell's open, attached when the Play wait fails.
 *
 * The hermetic CI profile retains no trace (traces disclose absolute source paths), so this
 * attachment is the only record of which state the monitor stopped in. Every value is a fixed
 * enum, a code token, a boolean or a bounded number. No URL, query, body, console text or copy
 * text leaves the page, and `scripts/browser_ci_evidence.py` (`open_diagnostic`) refuses any other
 * shape. Change both together.
 */
export const OPEN_DIAGNOSTICS_NAME = "integrated-shell-open-diagnostics";

const REQUEST_CAP = 64;
const VIDEO_CAP = 8;
const OVERLAY_CAP = 4;
const COLLECT_TIMEOUT_MS = 2_000;
const TOKEN = /^[a-z][a-z0-9_-]{0,47}$/;

export type MonitorState =
  | "closed"
  | "opening"
  | "paused"
  | "playing"
  | "closing"
  | "blocked"
  | "cleanup_pending"
  | "fallback"
  | "absent"
  | "unknown";
export type MonitorBlocker =
  | "source_unavailable"
  | "canvas_unavailable"
  | "invalid_contract"
  | "resource_limit"
  | "unknown";
export type RequestLabel =
  | "media:video"
  | "media:image"
  | "media:font"
  | "media:audio"
  | "media:other"
  | "fixture:bootstrap"
  | "fixture:transaction";
export type RequestRow = {
  label: RequestLabel;
  startMs: number;
  endMs: number | null;
  status: number | null;
  /** `aborted` is the page cancelling its own request; `failed` is any other network failure. */
  outcome: "ok" | "failed" | "aborted" | "pending";
};
export type VideoRow = {
  readyState: number;
  networkState: number;
  seeking: boolean;
  paused: boolean;
  currentTimeMs: number;
  errorCode: number;
};
export type OpenDiagnostics = {
  elapsedMs: number;
  monitor: MonitorState;
  blocker: MonitorBlocker | null;
  /** The pre-composition fallback region's code; `monitor` is then `fallback`. */
  fallback: string | null;
  overlays: string[];
  playDisabled: boolean | null;
  presentedFrame: boolean;
  timelineReady: boolean;
  audioState: string | null;
  audioReason: string | null;
  surface: string | null;
  ownership: {
    leaseOpens: number;
    sourceAcquired: number;
    sourceLive: number;
    acquisitionAttempts: number;
    acquisitionsInFlight: number;
    videoElements: number;
  } | null;
  preparation: {
    attempts: number;
    inFlight: number;
    aborted: number;
    released: number;
  } | null;
  videos: VideoRow[];
  requests: RequestRow[];
  requestsOmitted: number;
  pageErrors: number;
  consoleErrors: number;
  consoleWarnings: number;
};

export type ShellOpenObserver = Readonly<{
  /** Called immediately before the open gesture; request and elapsed times are relative to it. */
  markOpen(): void;
  collect(page: Page): Promise<OpenDiagnostics>;
}>;

function requestLabel(url: string): RequestLabel | null {
  const path = new URL(url).pathname;
  if (path.startsWith("/nle-media/")) {
    const kind = path.slice("/nle-media/".length);
    return kind === "video" ||
      kind === "image" ||
      kind === "font" ||
      kind === "audio"
      ? `media:${kind}`
      : "media:other";
  }
  if (path.startsWith("/__nle_fixture/"))
    return path === "/__nle_fixture/bootstrap"
      ? "fixture:bootstrap"
      : "fixture:transaction";
  return null;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : 0;
const ms = (value: number): number => Math.round(value * 10) / 10;
const token = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : typeof value === "string" && TOKEN.test(value)
      ? value
      : "unrecognized";

/**
 * Maps the monitor chip's sentence back to the status it was rendered from, through the product's
 * own English copy table, so the attachment carries the state and never the sentence.
 */
export function monitorStateFromText(
  text: string | null,
): Readonly<{ monitor: MonitorState; blocker: MonitorBlocker | null }> {
  if (text === null) return { monitor: "absent", blocker: null };
  const status = nleCopy("en").monitor.status;
  for (const state of [
    "closed",
    "opening",
    "paused",
    "playing",
    "closing",
    "cleanup_pending",
  ] as const)
    if (text === status[state]) return { monitor: state, blocker: null };
  const [head, tail] = status.blocked.split("{reason}");
  if (text.startsWith(head) && text.endsWith(tail)) {
    const reason = text.slice(head.length, text.length - tail.length);
    const blockers = nleCopy("en").monitor.blocker;
    for (const key of [
      "source_unavailable",
      "canvas_unavailable",
      "invalid_contract",
      "resource_limit",
    ] as const)
      if (reason === blockers[key]) return { monitor: "blocked", blocker: key };
    return { monitor: "blocked", blocker: "unknown" };
  }
  return { monitor: "unknown", blocker: null };
}

type PageFacts = {
  monitorText: string | null;
  fallback: string | null;
  overlays: string[];
  playDisabled: boolean | null;
  presentedFrame: boolean;
  timelineReady: boolean;
  audioState: string | null;
  audioReason: string | null;
  surface: string | null;
  ownership: Record<string, unknown> | null;
  preparation: Record<string, unknown> | null;
  videos: VideoRow[];
};

async function pageFacts(page: Page): Promise<PageFacts> {
  return page.evaluate(
    ({ overlayCap, videoCap }) => {
      const monitor = document.querySelector('[data-h3-nle-status="monitor"]');
      const audio = document.querySelector('[data-h3-nle-status="audio"]');
      const play = document.querySelector(
        '[data-h3-nle-control="transport.play"]',
      ) as HTMLButtonElement | null;
      const overlays = [...document.querySelectorAll("[data-h3-nle-overlay]")]
        .map((node) => node.getAttribute("data-h3-nle-overlay") ?? "")
        .slice(0, overlayCap);
      let snapshot: Record<string, unknown> | null = null;
      try {
        const harness = (
          window as unknown as {
            nleShellHarness?: { snapshot(): Record<string, unknown> };
          }
        ).nleShellHarness;
        snapshot = harness?.snapshot() ?? null;
      } catch {
        snapshot = null;
      }
      const debug = (
        window as unknown as {
          __nleMediaDebug?: {
            videoElementsByAsset: Map<string, HTMLVideoElement>;
            videoElementsByClip: Map<string, HTMLVideoElement>;
          };
        }
      ).__nleMediaDebug;
      const elements = debug
        ? [
            ...new Set([
              ...debug.videoElementsByClip.values(),
              ...debug.videoElementsByAsset.values(),
            ]),
          ]
        : [];
      return {
        monitorText: monitor?.textContent ?? null,
        // The monitor's fallback region carries the same status hook as the chip, before the
        // composition mounts; its code says which region it is.
        fallback: monitor?.getAttribute("data-h3-nle-fallback") ?? null,
        overlays,
        playDisabled: play === null ? null : play.disabled,
        presentedFrame:
          document
            .querySelector('canvas[data-h3-nle-canvas="composition"]')
            ?.hasAttribute("data-h3-nle-presented-frame") ?? false,
        timelineReady:
          document
            .querySelector('[data-h3-nle-status="timeline"]')
            ?.getAttribute("data-h3-nle-authoring") === "ready",
        audioState: audio?.getAttribute("data-h3-nle-audio-state") ?? null,
        audioReason: audio?.getAttribute("data-h3-nle-audio-reason") ?? null,
        surface:
          typeof snapshot?.surfaceStatus === "string"
            ? snapshot.surfaceStatus
            : null,
        ownership:
          (snapshot?.mediaOwnership as Record<string, unknown> | undefined) ??
          null,
        preparation:
          (snapshot?.mediaPreparation as Record<string, unknown> | undefined) ??
          null,
        videos: elements.slice(0, videoCap).map((element) => ({
          readyState: element.readyState,
          networkState: element.networkState,
          seeking: element.seeking,
          paused: element.paused,
          currentTimeMs: Number.isFinite(element.currentTime)
            ? Math.round(element.currentTime * 1000)
            : 0,
          errorCode: element.error?.code ?? 0,
        })),
      };
    },
    { overlayCap: OVERLAY_CAP, videoCap: VIDEO_CAP },
  );
}

/**
 * Observes the open's requests and console from before navigation. Install it before `goto`.
 */
export function observeShellOpen(page: Page): ShellOpenObserver {
  let openedAt: number | null = null;
  const began = performance.now();
  const origin = () => openedAt ?? began;
  const rows = new Map<Request, RequestRow>();
  let omitted = 0;
  let pageErrors = 0;
  let consoleErrors = 0;
  let consoleWarnings = 0;
  page.on("request", (request) => {
    const label = requestLabel(request.url());
    if (label === null) return;
    if (rows.size >= REQUEST_CAP) {
      omitted += 1;
      return;
    }
    rows.set(request, {
      label,
      startMs: ms(performance.now() - origin()),
      endMs: null,
      status: null,
      outcome: "pending",
    });
  });
  page.on("requestfinished", (request) => {
    const row = rows.get(request);
    if (row === undefined) return;
    row.endMs = ms(performance.now() - origin());
    row.outcome = "ok";
  });
  page.on("requestfailed", (request) => {
    const row = rows.get(request);
    if (row === undefined) return;
    row.endMs = ms(performance.now() - origin());
    // Only the closed class is kept, never the browser's error text.
    row.outcome = request.failure()?.errorText.includes("ERR_ABORTED")
      ? "aborted"
      : "failed";
  });
  page.on("response", (response) => {
    const row = rows.get(response.request());
    if (row !== undefined) row.status = response.status();
  });
  page.on("pageerror", () => {
    pageErrors = Math.min(1_000_000, pageErrors + 1);
  });
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors = Math.min(1_000_000, consoleErrors + 1);
    else if (message.type() === "warning")
      consoleWarnings = Math.min(1_000_000, consoleWarnings + 1);
  });
  return {
    markOpen() {
      if (openedAt !== null) return;
      // Times recorded before the gesture are rebased, so every row shares the gesture's origin.
      const now = performance.now();
      for (const row of rows.values()) {
        row.startMs = ms(row.startMs - (now - began));
        if (row.endMs !== null) row.endMs = ms(row.endMs - (now - began));
      }
      openedAt = now;
    },
    async collect(target) {
      const facts = await pageFacts(target);
      const { monitor, blocker } =
        facts.fallback === null
          ? monitorStateFromText(facts.monitorText)
          : { monitor: "fallback" as const, blocker: null };
      const own = facts.ownership;
      const prep = facts.preparation;
      return {
        elapsedMs: ms(performance.now() - origin()),
        monitor,
        blocker,
        fallback: token(facts.fallback),
        overlays: facts.overlays.map((value) => token(value) ?? "unrecognized"),
        playDisabled: facts.playDisabled,
        presentedFrame: facts.presentedFrame,
        timelineReady: facts.timelineReady,
        audioState: token(facts.audioState),
        audioReason: token(facts.audioReason),
        surface: token(facts.surface),
        ownership:
          own === null
            ? null
            : {
                leaseOpens: count(own.leaseOpens),
                sourceAcquired: count(own.sourceAcquired),
                sourceLive: count(own.sourceLive),
                acquisitionAttempts: count(own.acquisitionAttempts),
                acquisitionsInFlight: count(own.acquisitionsInFlight),
                videoElements: count(own.videoElements),
              },
        preparation:
          prep === null
            ? null
            : {
                attempts: count(prep.attempts),
                inFlight: count(prep.inFlight),
                aborted: count(prep.aborted),
                released: count(prep.released),
              },
        videos: facts.videos.map((video) => ({
          readyState: count(video.readyState),
          networkState: count(video.networkState),
          seeking: video.seeking === true,
          paused: video.paused === true,
          currentTimeMs: count(video.currentTimeMs),
          errorCode: count(video.errorCode),
        })),
        requests: [...rows.values()].map((row) => ({ ...row })),
        requestsOmitted: omitted,
        pageErrors,
        consoleErrors,
        consoleWarnings,
      };
    },
  };
}

/**
 * Attaches the open diagnostics to the running test. It never throws and never waits longer than
 * a short bound, so the caller can rethrow the original failure unchanged.
 *
 * IMPORTANT: call this where the failure is caught, as `openIntegratedShell` does. Do not move it
 * into a `test.afterEach` registered at the top level of a shared helper: Playwright adds such a
 * hook only to the spec file that is loading when the call runs, and Node evaluates a shared
 * module once per worker, so every later spec file in that worker would silently lose it. That is
 * exactly how a Hosted failure of this wait once kept no diagnostic at all.
 */
export async function attachOpenDiagnostics(
  page: Page,
  observer: ShellOpenObserver,
): Promise<void> {
  try {
    const facts = await Promise.race([
      observer.collect(page),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), COLLECT_TIMEOUT_MS).unref(),
      ),
    ]);
    if (facts === null) return;
    await test.info().attach(OPEN_DIAGNOSTICS_NAME, {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(facts)),
    });
  } catch {
    // A diagnostic must never replace the failure it describes.
  }
}
