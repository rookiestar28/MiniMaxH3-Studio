import { expect, test, type Page } from "@playwright/test";

import {
  monitorStateFromText,
  observeShellOpen,
  OPEN_DIAGNOSTICS_NAME,
  type OpenDiagnostics,
} from "../helpers/integratedShellDiagnostics";
import { openIntegratedShell } from "../helpers/nleShell";

// The open diagnostic is the only record a hermetic CI failure keeps of where the monitor stopped,
// because that profile retains no trace. These cases prove its readings against states the
// harness can force, and prove that a failed open attaches it from this file, which is never the
// first spec file a worker loads.

const abortFont = async (page: Page) => {
  await page.route("**/nle-media/font", (route) => route.abort());
};

const labels = (facts: OpenDiagnostics) =>
  facts.requests
    .filter((row) => row.label.startsWith("media:"))
    .map((row) => `${row.label}:${row.outcome}`)
    .sort();
const answered = (facts: OpenDiagnostics, label: string) =>
  facts.requests.filter((row) => row.label === label && row.outcome === "ok")
    .length;

test("the open diagnostic maps only the product's own status sentences", () => {
  expect(monitorStateFromText(null)).toEqual({
    monitor: "absent",
    blocker: null,
  });
  expect(monitorStateFromText("Opening monitor.")).toEqual({
    monitor: "opening",
    blocker: null,
  });
  expect(
    monitorStateFromText("Monitor unavailable: source unavailable."),
  ).toEqual({ monitor: "blocked", blocker: "source_unavailable" });
  expect(monitorStateFromText("Monitor unavailable: anything else.")).toEqual({
    monitor: "blocked",
    blocker: "unknown",
  });
  expect(monitorStateFromText("D:/clips/take-01.mp4")).toEqual({
    monitor: "unknown",
    blocker: null,
  });
});

test("a healthy open reads paused with every generic source answered", async ({
  page,
}) => {
  const observer = observeShellOpen(page);
  await openIntegratedShell(page, "smoke");
  const facts = await observer.collect(page);
  expect(facts.monitor).toBe("paused");
  expect(facts.blocker).toBeNull();
  expect(facts.playDisabled).toBe(false);
  expect(facts.timelineReady).toBe(true);
  // The media bin's decorations also fetch, and the page cancels some of them, so only the
  // answered sources the composition needs are pinned: the font, the still and both videos.
  expect(answered(facts, "media:font")).toBeGreaterThanOrEqual(1);
  expect(answered(facts, "media:image")).toBeGreaterThanOrEqual(1);
  expect(answered(facts, "media:video")).toBeGreaterThanOrEqual(2);
  expect(labels(facts)).not.toContain("media:font:failed");
  expect(facts.pageErrors).toBe(0);
});

// IMPORTANT: the product's source owner hands the runtime a video only after its metadata has
// loaded. A harness that hands one over at HAVE_NOTHING makes the runtime's first seek a no-op, so
// the open rests on one first-frame callback a busy browser can lose: the monitor then latches
// "source unavailable" about once in 30-60 opens on two CPUs. This pins the precondition directly.
test("the harness hands every source video over with metadata, as the product does", async ({
  page,
}) => {
  await openIntegratedShell(page, "smoke");
  const states = await page.evaluate(
    () => window.__nleMediaDebug?.sourceHandoverReadyStates ?? null,
  );
  expect(states).not.toBeNull();
  // The smoke open leases the primary video twice: the picture and the audio follower.
  expect(states!.length).toBeGreaterThanOrEqual(2);
  expect(states!.filter((state) => state < 1)).toEqual([]);
});

test("an aborted font reads blocked with its reason and the unavailable overlay", async ({
  page,
}) => {
  const observer = observeShellOpen(page);
  await openIntegratedShell(page, "smoke", {
    beforeOpen: abortFont,
    expandOverlay: false,
  });
  await page
    .locator("#root")
    .getByRole("button", { name: "Open full editor" })
    .click();
  // IMPORTANT: wait on the diagnostic's own reading, not on an "unavailable" overlay. The monitor
  // shows its pre-composition fallback, which also carries that overlay, for about 50 ms before it
  // opens, so an overlay wait can read `fallback` or `opening` here.
  await expect
    .poll(async () => (await observer.collect(page)).monitor)
    .toBe("blocked");
  const facts = await observer.collect(page);
  expect(facts.fallback).toBeNull();
  expect(facts.blocker).toBe("source_unavailable");
  expect(facts.overlays).toContain("unavailable");
  expect(facts.playDisabled).toBe(true);
  expect(labels(facts)).toContain("media:font:failed");
});

test("a failed open attaches exactly one closed open diagnostic", async ({
  page,
}, info) => {
  await expect(
    openIntegratedShell(page, "smoke", {
      beforeOpen: abortFont,
      openTimeoutMs: 3_000,
    }),
  ).rejects.toThrow("toBeEnabled");
  const attached = info.attachments.filter(
    (item) => item.name === OPEN_DIAGNOSTICS_NAME,
  );
  expect(attached).toHaveLength(1);
  expect(attached[0].contentType).toBe("application/json");
  const facts = JSON.parse(attached[0].body!.toString()) as OpenDiagnostics;
  expect(facts.monitor).toBe("blocked");
  expect(facts.blocker).toBe("source_unavailable");
  expect(facts.playDisabled).toBe(true);
  expect(facts.elapsedMs).toBeGreaterThanOrEqual(3_000);
  const text = JSON.stringify(facts);
  for (const forbidden of ["http", "nle-media/", "asset=", "Monitor ", ":/"])
    expect(text).not.toContain(forbidden);
});
