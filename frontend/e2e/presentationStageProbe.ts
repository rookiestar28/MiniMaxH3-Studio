// Test-only monotonic clocks. No source ids, media metadata, keys, or DOM content are retained.
export type Stage =
  | "keydown"
  | "seek-request"
  | "runtime-seek"
  | "video-seeking"
  | "video-seeked"
  | "native-frame"
  | "paint-start"
  | "paint-end"
  | "delivered";
type Token = Readonly<{ navigation: number; epoch: number }>;
type Event = Readonly<{ navigation: number; stage: Stage; atMs: number }>;
type Snapshot = Readonly<{ atMs: number; durationMs: number }>;

export function createPresentationStageProbe(
  clock: () => number = () => performance.now(),
) {
  let origin = clock();
  let epoch = 0;
  let navigation = 0;
  let active: Token | undefined;
  let eventsDropped = 0;
  let callbackCount = 0;
  const events: Event[] = [];
  const snapshots: Snapshot[] = [];
  const observed = new WeakSet<HTMLVideoElement>();
  // Keep queued callbacks on their requesting token; relabeling with the latest
  // navigation attributes an older paint to the next key, including after reset.
  function mark(stage: Stage, token = active): Token | undefined {
    callbackCount += 1;
    if (token === undefined || token.epoch !== epoch) return undefined;
    if (events.length >= 20_000) eventsDropped += 1;
    else
      events.push({
        navigation: token.navigation,
        stage,
        atMs: clock() - origin,
      });
    return token;
  }
  return {
    mark,
    capture: () => active,
    navigation() {
      active = { navigation: ++navigation, epoch };
      mark("keydown");
    },
    phase(phase: string) {
      if (phase !== "navigation") active = undefined;
    },
    observeVideo(video: HTMLVideoElement) {
      if (observed.has(video)) return;
      observed.add(video);
      video.addEventListener("seeking", () => mark("video-seeking"));
      video.addEventListener("seeked", () => mark("video-seeked"));
    },
    snapshot<T>(read: () => T): T {
      const start = clock();
      try {
        return read();
      } finally {
        if (snapshots.length >= 4096) eventsDropped += 1;
        else
          snapshots.push({ atMs: start - origin, durationMs: clock() - start });
      }
    },
    reset() {
      epoch += 1;
      active = undefined;
      navigation = 0;
      eventsDropped = 0;
      callbackCount = 0;
      events.length = 0;
      snapshots.length = 0;
      origin = clock();
    },
    read() {
      return {
        version: 1,
        eventsDropped,
        callbackCount,
        events: [...events],
        snapshots: [...snapshots],
      };
    },
  };
}

declare global {
  interface Window {
    __nleStageTrace?: ReturnType<typeof createPresentationStageProbe>;
  }
}

export function installPresentationStageProbe() {
  const probe = createPresentationStageProbe();
  window.__nleStageTrace = probe;
  const keys = new Set([
    "Home",
    "End",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
  ]);
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        keys.has(event.key) &&
        event.target instanceof Element &&
        event.target.closest('[data-h3-nle-surface="overlay_v1"]')
      )
        probe.navigation();
    },
    true,
  );
  return probe;
}
