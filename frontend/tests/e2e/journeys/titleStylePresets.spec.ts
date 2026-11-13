import { expect, test, type Page } from "@playwright/test";
import type { CompositionClip } from "../../../src/contracts/compositionCodec";
import { canonicalWorkspace, snapshot, surface } from "../helpers/nleCanonical";
import { routeGenericFixtureMedia } from "../helpers/genericFixtureMedia";
import { playheadSlider, seekPlayhead } from "../helpers/nleTimeline";

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const ordered = (clips: readonly CompositionClip[]) =>
  [...clips].sort((a, b) => a.clipId.localeCompare(b.clipId));

async function insertPreset(page: Page, allocate: boolean) {
  await routeGenericFixtureMedia(page);
  const transactions = await canonicalWorkspace(
    page,
    (wire) => {
      const tracks = wire.tracks as { track_id: string; kind: string }[];
      const textTracks = new Set(
        tracks
          .filter((track) => track.kind === "text_overlay")
          .map((track) => track.track_id),
      );
      wire.clips = (wire.clips as { track_id: string }[]).filter(
        (clip) => !textTracks.has(clip.track_id),
      );
      if (allocate)
        wire.tracks = tracks.filter((track) => !textTracks.has(track.track_id));
    },
    undefined,
    "&media=1",
  );
  const before = (await snapshot(page)).timelineSnapshot!;
  await seekPlayhead(page, playheadSlider(page), 18);
  await page.locator('[data-h3-nle-pane="text"]').click();
  const content = page.getByLabel("Title text", { exact: true });
  const tile = page.locator(
    '[data-h3-nle-control="title.insert_preset"][data-h3-nle-preset="boldOutline"]',
  );
  await content.fill("Title 😀");
  await expect(tile).toBeDisabled();
  expect(transactions).toHaveLength(0);
  expect((await snapshot(page)).receipts).toBe(0);
  expect((await snapshot(page)).timelineSnapshot!.tracks).toEqual(
    before.tracks,
  );
  await content.fill("Opening card");
  await expect(tile).toBeEnabled();
  if (allocate) await tile.click();
  else {
    await tile.focus();
    await tile.press("Enter");
  }
  await expect.poll(async () => (await snapshot(page)).receipts).toBe(1);
  expect(transactions).toHaveLength(1);
  const commands = (
    transactions[0] as { commands: { kind: string; payload: unknown }[] }
  ).commands;
  expect(commands.map((command) => command.kind)).toEqual(
    allocate ? ["create_track", "insert_title_clip"] : ["insert_title_clip"],
  );
  expect(commands.at(-1)).toMatchObject({
    payload: {
      clip: {
        start_frame: 18,
        text: {
          content: "Opening card",
          weight: 700,
          stroke: { width_px: 5 },
          shadow: { offset_x_px: 2, offset_y_px: 2 },
        },
      },
    },
  });
  const after = (await snapshot(page)).timelineSnapshot!;
  expect(after.tracks).toHaveLength(before.tracks.length + Number(allocate));
  expect(after.clips).toHaveLength(before.clips.length + 1);
  await page.locator('[data-h3-nle-control="history.undo"]').click();
  await expect.poll(async () => (await snapshot(page)).receipts).toBe(2);
  expect((await snapshot(page)).timelineSnapshot!.tracks).toEqual(
    before.tracks,
  );
  expect(ordered((await snapshot(page)).timelineSnapshot!.clips)).toEqual(
    ordered(before.clips),
  );
  await page.locator('[data-h3-nle-control="history.redo"]').click();
  await expect.poll(async () => (await snapshot(page)).receipts).toBe(3);
  expect((await snapshot(page)).timelineSnapshot!.tracks).toEqual(after.tracks);
  expect((await snapshot(page)).timelineSnapshot!.clips).toEqual(after.clips);
  expect(
    await page
      .locator(surface)
      .evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
}

test("preset insert reuses a text track in one intent with refusal recovery and history", async ({
  page,
}) => {
  await insertPreset(page, false);
});
test("preset insert allocates a text track in one intent with refusal recovery and history", async ({
  page,
}) => {
  await insertPreset(page, true);
});
test("preset apply replaces the accepted style in one intent with no-op refusal and history", async ({
  page,
}) => {
  await routeGenericFixtureMedia(page);
  const transactions = await canonicalWorkspace(
    page,
    (wire) => {
      const title = (
        wire.clips as { text: Record<string, unknown> | null }[]
      ).find((clip) => clip.text)!;
      Object.assign(title.text!, {
        size_px: 91,
        align: "left",
        line_height_bp: 17000,
        stroke: { rgba: [0, 255, 0, 255], width_px: 9 },
        shadow: { rgba: [1, 2, 3, 255], offset_x_px: 7, offset_y_px: 8 },
      });
    },
    undefined,
    "&media=1",
  );
  const before = (await snapshot(page)).timelineSnapshot!;
  const title = before.clips.find((clip) => clip.text)!;
  await page
    .locator(
      `[data-h3-nle-clip="${title.clipId}"] [data-h3-nle-control="selection.set"]`,
    )
    .click();
  await expect.poll(async () => (await snapshot(page)).receipts).toBe(1);
  expect(transactions).toMatchObject([
    {
      commands: [
        { kind: "select_clips", payload: { clip_ids: [title.clipId] } },
      ],
    },
  ]);
  // The canonical oracle replays the full history; never splice transactions.
  // Measure each action from baselines captured after its setup receipt.
  const transactionBaseline = transactions.length;
  const receiptBaseline = (await snapshot(page)).receipts;
  const inspector = page.locator('[data-h3-nle-area="inspector"]');
  await inspector.getByRole("tab", { name: "Text", exact: true }).click();
  const size = inspector.getByRole("spinbutton", {
    name: "Size (px)",
    exact: true,
  });
  await size.fill("144");
  const tile = inspector.locator(
    '[data-h3-nle-control="text.apply_preset"][data-h3-nle-preset="captionBox"]',
  );
  await expect(tile).toBeEnabled();
  await tile.focus();
  await tile.press("Space");
  await expect
    .poll(async () => (await snapshot(page)).receipts)
    .toBe(receiptBaseline + 1);
  const actionTransactions = transactions.slice(transactionBaseline);
  expect(actionTransactions).toHaveLength(1);
  const commands = (
    actionTransactions[0] as { commands: { kind: string; payload: unknown }[] }
  ).commands;
  expect(commands.map((command) => command.kind)).toEqual(["set_text_style"]);
  const {
    stroke: _stroke,
    shadow: _shadow,
    backgroundPaddingPx: _padding,
    ...base
  } = title.text!;
  const expected = {
    ...base,
    weight: 400,
    style: "normal",
    fillRgba: [255, 255, 255, 255],
    backgroundRgba: [0, 0, 0, 153],
    backgroundPaddingPx: 8,
  };
  expect(commands[0]).toMatchObject({
    payload: {
      clip_id: title.clipId,
      style: {
        font_asset_id: title.text!.fontAssetId,
        size_px: 91,
        align: "left",
        line_height_bp: 17000,
        background_rgba: [0, 0, 0, 153],
        background_padding_px: 8,
      },
    },
  });
  const after = (await snapshot(page)).timelineSnapshot!;
  expect(
    after.clips.find((clip) => clip.clipId === title.clipId)!.text,
  ).toEqual(expected);
  await expect(size).toHaveValue("91");
  await expect(tile).toBeDisabled();
  expect(transactions.slice(transactionBaseline)).toHaveLength(1);
  await page.locator('[data-h3-nle-control="history.undo"]').click();
  await expect
    .poll(async () => (await snapshot(page)).receipts)
    .toBe(receiptBaseline + 2);
  expect(ordered((await snapshot(page)).timelineSnapshot!.clips)).toEqual(
    ordered(before.clips),
  );
  await page.locator('[data-h3-nle-control="history.redo"]').click();
  await expect
    .poll(async () => (await snapshot(page)).receipts)
    .toBe(receiptBaseline + 3);
  expect((await snapshot(page)).timelineSnapshot!.clips).toEqual(after.clips);
  expect(
    await page
      .locator(surface)
      .evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
});
