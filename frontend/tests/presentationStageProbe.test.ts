import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPresentationStageProbe } from "../e2e/presentationStageProbe";
import { instrumentPresentationStages } from "../e2e/presentationStagePlugin";

describe("content-free presentation stage clocks", () => {
  it("keeps delayed paints assigned to their original navigation and rejects pre-reset tokens", () => {
    let now = 10;
    const probe = createPresentationStageProbe(() => now++);
    probe.navigation();
    const first = probe.mark("paint-start");
    probe.navigation();
    probe.mark("delivered", first);
    expect(probe.read().events.at(-1)?.navigation).toBe(1);
    probe.reset();
    probe.navigation();
    probe.mark("delivered", first);
    expect(probe.read().events.map(({ stage }) => stage)).toEqual(["keydown"]);
  });
  it("measures snapshot work including a throwing reader and preserves its result", () => {
    let now = 0;
    const probe = createPresentationStageProbe(() => now);
    const result = {};
    expect(
      probe.snapshot(() => {
        now += 4;
        return result;
      }),
    ).toBe(result);
    expect(() =>
      probe.snapshot(() => {
        now += 2;
        throw Error("synthetic");
      }),
    ).toThrow("synthetic");
    expect(probe.read().snapshots).toEqual([
      { atMs: 0, durationMs: 4 },
      { atMs: 4, durationMs: 2 },
    ]);
  });
  it("bounds evidence and reports overflow instead of returning a partial passing trace", () => {
    const probe = createPresentationStageProbe(() => 1);
    probe.navigation();
    for (let index = 0; index < 20_000; index++) probe.mark("runtime-seek");
    expect(probe.read().events).toHaveLength(20_000);
    expect(probe.read().eventsDropped).toBe(1);
  });
  it("observes native events once without replacing the native frame callback", () => {
    const video = document.createElement("video");
    const request = vi.fn(() => 42);
    video.requestVideoFrameCallback = request;
    const probe = createPresentationStageProbe();
    probe.navigation();
    probe.observeVideo(video);
    probe.observeVideo(video);
    video.dispatchEvent(new Event("seeking"));
    video.dispatchEvent(new Event("seeked"));
    expect(video.requestVideoFrameCallback).toBe(request);
    expect(probe.read().events.map(({ stage }) => stage)).toEqual([
      "keydown",
      "video-seeking",
      "video-seeked",
    ]);
    expect(probe.read().callbackCount).toBe(3);
  });
  it("keeps stage transforms and probes out of the production build configuration", () => {
    const config = readFileSync(resolve("vite.config.ts"), "utf8");
    expect(config).not.toMatch(/presentationStage|__nleStageTrace/);
    const entry = readFileSync(resolve("src/entry.tsx"), "utf8");
    expect(entry).not.toMatch(/presentationStage|__nleStageTrace/);
  });
  it.each(["visualCompositionSession", "editorRuntime"])(
    "pins every served stage anchor in %s and refuses drift",
    (name) => {
      const id = `/src/runtime/${name}.ts`;
      const source = readFileSync(
        resolve(`src/runtime/${name}.ts`),
        "utf8",
      ).replaceAll("\r\n", "\n");
      const instrumented = instrumentPresentationStages(source, id);
      expect(instrumented).toContain("window.__nleStageTrace");
      const crlfInstrumented = instrumentPresentationStages(
        source.replaceAll("\n", "\r\n"),
        id,
      );
      expect(crlfInstrumented).toBe(instrumented?.replaceAll("\n", "\r\n"));
      expect(crlfInstrumented?.split("\n").length).toBe(
        instrumented?.split("\n").length,
      );
      const marks = new Set(
        instrumented?.match(/window\.__nleStageTrace\?\.\w+\([^)]*\)/g),
      );
      expect(marks.size).toBeGreaterThan(0);
      for (const mark of marks)
        expect(crlfInstrumented?.split(mark).length).toBe(
          instrumented?.split(mark).length,
        );
      expect(() => instrumentPresentationStages("", id)).toThrow(
        "anchor drift",
      );
      expect(instrumentPresentationStages(source, "/unrelated.ts")).toBeNull();
    },
  );
});
