import { expect, test } from "@playwright/test";
import { WIPE_KINDS } from "../../../src/contracts/compositionCodec";
import type { observeWipe } from "../../../e2e/wipeCompositor";
import { canonicalWorkspace, snapshot } from "../helpers/nleCanonical";
import { routeGenericFixtureMedia } from "../helpers/genericFixtureMedia";

declare global {
  interface Window {
    observeWipe: typeof observeWipe;
  }
}

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

for (const kind of [...WIPE_KINDS, "cross_dissolve_v1"] as const)
  test(`${kind} survives inspector reopen, applies once and follows undo and redo`, async ({
    page,
  }, testInfo) => {
    await routeGenericFixtureMedia(page);
    const transactions = await canonicalWorkspace(
      page,
      undefined,
      undefined,
      "&media=1&retention=1",
    );
    const inspector = page.locator('[data-h3-nle-area="inspector"]');
    await page
      .locator(
        '[data-h3-nle-clip="clip-2"] [data-h3-nle-control="selection.set"]',
      )
      .click();
    await inspector
      .getByRole("tab", { name: "Transition", exact: true })
      .click();
    const select = inspector.getByRole("combobox", {
      name: "Transition",
      exact: true,
    });
    const duration = inspector.getByRole("spinbutton", {
      name: "Transition frames",
      exact: true,
    });
    const apply = inspector.locator(
      '[data-h3-nle-control="boundary.transition"]',
    );
    await inspector.screenshot({
      path: testInfo.outputPath("transition-baseline.png"),
    });
    const before = (await snapshot(page)).timelineSnapshot!.clips.find(
      (clip) => clip.clipId === "clip-2",
    )!;
    const receipts = (await snapshot(page)).receipts;
    await select.selectOption(kind);
    await duration.fill("12");
    await page.locator('[data-h3-nle-action="close"]').click();
    await expect(
      page.locator('[data-h3-nle-surface="overlay_v1"]'),
    ).toHaveCount(0);
    await page.locator('[data-h3-nle-entry="open"]').click();
    await expect(select).toHaveValue(kind);
    await expect(duration).toHaveValue("12");
    expect((await snapshot(page)).receipts).toBe(receipts);
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect
      .poll(async () => (await snapshot(page)).receipts)
      .toBe(receipts + 1);
    const current = () =>
      snapshot(page).then((value) =>
        value.timelineSnapshot!.clips.find((clip) => clip.clipId === "clip-2")!,
      );
    expect((await current()).transition).toEqual({ kind, durationFrames: 12 });
    expect(transactions.at(-1)).toMatchObject({
      commands: [
        {
          kind: "set_transition",
          payload: {
            clip_id: "clip-2",
            transition: { kind, duration_frames: 12 },
          },
        },
      ],
    });
    await expect(apply).toBeDisabled();
    await inspector.screenshot({
      path: testInfo.outputPath(`${kind}-accepted.png`),
    });
    await page.locator('[data-h3-nle-control="history.undo"]').click();
    await expect
      .poll(async () => (await snapshot(page)).receipts)
      .toBe(receipts + 2);
    expect((await current()).transition).toEqual(before.transition);
    await page.locator('[data-h3-nle-control="history.redo"]').click();
    await expect
      .poll(async () => (await snapshot(page)).receipts)
      .toBe(receipts + 3);
    expect((await current()).transition).toEqual({ kind, durationFrames: 12 });
    await expect(select).toHaveValue(kind);
  });

for (const [locale, label, names, refusal] of [
  [
    "en",
    "Transition",
    [
      "None",
      "Cross dissolve",
      "Wipe from left",
      "Wipe from right",
      "Wipe from top",
      "Wipe from bottom",
    ],
    "A transition needs an enabled clip on a lower track that plays for the whole transition, and a length this clip allows.",
  ],
  [
    "zh-TW",
    "轉場",
    ["無", "交叉溶解", "從左擦入", "從右擦入", "從上擦入", "從下擦入"],
    "轉場需要下層軌道上有已啟用、且在整段轉場期間持續播放的片段，以及此片段允許的長度。",
  ],
  [
    "zh-CN",
    "转场",
    ["无", "交叉溶解", "从左擦入", "从右擦入", "从上擦入", "从下擦入"],
    "转场需要下层轨道上有已启用、且在整段转场期间持续播放的片段，以及此片段允许的长度。",
  ],
] as const) {
  test(`localized wipe selector in ${locale} keeps each exact draft kind`, async ({
    page,
  }, testInfo) => {
    await routeGenericFixtureMedia(page);
    const transactions = await canonicalWorkspace(
      page,
      undefined,
      undefined,
      `&media=1&locale=${locale}`,
    );
    const transitionTransactions = () =>
      transactions.filter((value) =>
        (value as { commands: { kind: string }[] }).commands.some(
          (command) => command.kind === "set_transition",
        ),
      );
    await page
      .locator(
        '[data-h3-nle-clip="clip-2"] [data-h3-nle-control="selection.set"]',
      )
      .click();
    const inspector = page.locator('[data-h3-nle-area="inspector"]');
    await inspector.getByRole("tab", { name: label, exact: true }).click();
    const select = inspector.getByRole("combobox", {
      name: label,
      exact: true,
    });
    // Pin the complete labels before selecting: a missing label otherwise waits until
    // the action deadline instead of identifying the broken localized selector.
    await expect(select.locator("option")).toHaveText(names);
    expect(
      await select
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        ),
    ).toEqual([
      "none",
      "cross_dissolve_v1",
      "wipe_from_left_v1",
      "wipe_from_right_v1",
      "wipe_from_top_v1",
      "wipe_from_bottom_v1",
    ]);
    for (const [index, kind] of WIPE_KINDS.entries()) {
      await select.selectOption({ label: names[index + 2]! });
      await expect(select).toHaveValue(kind);
    }
    await page
      .locator(
        '[data-h3-nle-clip="clip-0"] [data-h3-nle-control="selection.set"]',
      )
      .click();
    await inspector.getByRole("tab", { name: label, exact: true }).click();
    const apply = inspector.locator(
      '[data-h3-nle-control="boundary.transition"]',
    );
    await select.selectOption("cross_dissolve_v1");
    await expect(inspector.getByRole("alert")).toBeVisible();
    await inspector.screenshot({
      path: testInfo.outputPath("transition-refusal.png"),
    });
    for (const kind of ["cross_dissolve_v1", ...WIPE_KINDS]) {
      await select.selectOption(kind);
      await expect(inspector.getByRole("alert")).toHaveText(refusal);
      await expect(apply).toBeDisabled();
    }
    expect(transitionTransactions()).toHaveLength(0);
    await select.selectOption("none");
    await expect(inspector.getByRole("alert")).toHaveCount(0);
    await page
      .locator(
        '[data-h3-nle-clip="clip-2"] [data-h3-nle-control="selection.set"]',
      )
      .click();
    await inspector.getByRole("tab", { name: label, exact: true }).click();
    await select.selectOption(WIPE_KINDS[0]);
    await expect(inspector.getByRole("alert")).toHaveCount(0);
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect
      .poll(
        async () =>
          (await snapshot(page)).timelineSnapshot!.clips.find(
            (clip) => clip.clipId === "clip-2",
          )!.transition.kind,
      )
      .toBe(WIPE_KINDS[0]);
    expect(transitionTransactions()).toHaveLength(1);
    expect(transitionTransactions()[0]).toMatchObject({
      commands: [{ kind: "set_transition", payload: { clip_id: "clip-2" } }],
    });
  });
}

for (const kind of WIPE_KINDS)
  for (const native of [false, true])
    for (const rotated of [false, true]) {
      test(`${kind} ${native ? "native" : "software"} ${rotated ? "quarter-turn" : "unrotated"} has exact spatial coverage and preserved alpha`, async ({
        page,
      }, testInfo) => {
        await page.goto("/wipeCompositor.html");
        await page.waitForFunction(
          () => typeof window.observeWipe === "function",
        );
        const result = await page.evaluate(
          async ({ kind, native, rotated }) =>
            window.observeWipe(kind, native, rotated),
          { kind, native, rotated },
        );
        await testInfo.attach("pixel-readback", {
          body: JSON.stringify(result, null, 2),
          contentType: "application/json",
        });
        expect(result.path).toBe(native ? "native" : "software");
        expect([result.width, result.height]).toEqual([128, 128]);
        expect(result.frames.map((frame) => frame.elapsed)).toEqual([
          0, 2, 5, 6, 5, 2, 0,
        ]);
        for (const frame of result.frames) {
          expect(frame.receipt).toBe("presented");
          expect(frame.mismatches, JSON.stringify(frame)).toBe(0);
          expect(frame.maxError).toBeLessThanOrEqual(1);
          const horizontal = kind.includes("left") || kind.includes("right");
          expect(frame.revealed).toBe(
            horizontal
              ? Math.floor((64 * frame.elapsed) / 6) * 48
              : Math.floor((48 * frame.elapsed) / 6) * 64,
          );
        }
      });
    }

for (const kind of WIPE_KINDS)
  for (const native of [false, true])
    for (const rotated of [false, true]) {
      test(`${kind} ${native ? "native" : "software"} ${rotated ? "quarter-turn" : "unrotated"} clips actual text and its background`, async ({
        page,
      }, testInfo) => {
        await page.goto("/wipeCompositor.html");
        await page.waitForFunction(
          () => typeof window.observeTextWipe === "function",
        );
        const result = await page.evaluate(
          async ({ kind, native, rotated }) =>
            window.observeTextWipe(kind, native, rotated),
          { kind, native, rotated },
        );
        await testInfo.attach("text-pixel-readback", {
          body: JSON.stringify(result, null, 2),
          contentType: "application/json",
        });
        expect(result.path).toBe(native ? "native" : "software");
        expect([result.width, result.height]).toEqual([128, 128]);
        expect(result.fullReceipt).toBe("presented");
        expect(result.inkPixels).toBeGreaterThan(2000);
        expect(result.frames.map((frame) => frame.elapsed)).toEqual([
          0, 2, 5, 6, 5, 2, 0,
        ]);
        for (const frame of result.frames) {
          expect(frame.receipt).toBe("presented");
          expect(frame.mismatches, JSON.stringify(frame)).toBe(0);
          expect(frame.maxError).toBeLessThanOrEqual(1);
          if (frame.elapsed === 0) expect(frame.visibleInk).toBe(0);
          else if (frame.elapsed === 6)
            expect(frame.visibleInk).toBe(result.inkPixels);
          else expect(frame.visibleInk).toBeGreaterThan(500);
        }
      });
    }

for (const native of [false, true])
  for (const rotated of [false, true]) {
    test(`cross dissolve ${native ? "native" : "software"} ${rotated ? "quarter-turn" : "unrotated"} conserves its alpha ramp while scrubbing`, async ({
      page,
    }, testInfo) => {
      await page.goto("/wipeCompositor.html");
      await page.waitForFunction(
        () => typeof window.observeWipe === "function",
      );
      const result = await page.evaluate(
        async ({ native, rotated }) =>
          window.observeWipe("cross_dissolve_v1", native, rotated),
        { native, rotated },
      );
      await testInfo.attach("dissolve-pixel-readback", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
      expect(result.path).toBe(native ? "native" : "software");
      expect(result.frames.map((frame) => frame.elapsed)).toEqual([
        0, 2, 5, 6, 5, 2, 0,
      ]);
      for (const frame of result.frames) {
        expect(frame.receipt).toBe("presented");
        expect(frame.mismatches, JSON.stringify(frame)).toBe(0);
        expect(frame.maxError).toBeLessThanOrEqual(1);
        expect(frame.revealed).toBe(64 * 48);
      }
    });
  }

for (const kind of WIPE_KINDS)
  for (const native of [false, true])
    for (const rotated of [false, true]) {
      test(`${kind} ${native ? "native" : "software"} ${rotated ? "quarter-turn" : "unrotated"} preserves scaled spatial coverage`, async ({
        page,
      }, testInfo) => {
        await page.goto("/wipeCompositor.html");
        await page.waitForFunction(
          () => typeof window.observeWipe === "function",
        );
        const result = await page.evaluate(
          async ({ kind, native, rotated }) =>
            window.observeWipe(kind, native, rotated, true),
          { kind, native, rotated },
        );
        await testInfo.attach("scaled-pixel-readback", {
          body: JSON.stringify(result, null, 2),
          contentType: "application/json",
        });
        expect(result.path).toBe(native ? "native" : "software");
        expect([result.width, result.height]).toEqual([320, 320]);
        expect(result.frames.map((frame) => frame.elapsed)).toEqual([
          0, 2, 5, 6, 5, 2, 0,
        ]);
        for (const frame of result.frames) {
          expect(frame.receipt).toBe("presented");
          expect(frame.mismatches, JSON.stringify(frame)).toBe(0);
          expect(frame.maxError).toBeLessThanOrEqual(1);
          const horizontal = kind.includes("left") || kind.includes("right");
          expect(frame.revealed).toBe(
            horizontal
              ? (Math.floor((96 * frame.elapsed) / 6) * 72) / 4
              : (Math.floor((72 * frame.elapsed) / 6) * 96) / 4,
          );
        }
      });
    }
