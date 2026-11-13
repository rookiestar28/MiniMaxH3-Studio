import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NleTextBin } from "../src/components/nle/NleTextBin";
import { NleInspectorTabs } from "../src/components/nle/NleInspectorTabs";
import { createSidebarRetention } from "../src/state/sidebarRetention";
import {
  SMOKE_SHAPE,
  snapshotFixture,
  authoringReady,
} from "./support/nleWorkspaceFixture";
import * as fonts from "../src/components/nle/nleTextPresetFonts";
import {
  applyPreset,
  TEXT_PRESETS,
} from "../src/components/nle/nleTextPresets";
import { textStyleWire } from "../src/components/nle/nleCommandBuilders";
import { NleTextPresetGrid } from "../src/components/nle/NleTextPresetGrid";
import * as compositor from "../src/runtime/visualCompositor";
import type { AuthoringIntent } from "../src/state/authoringViewState";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(compositor, "drawText").mockImplementation(() => undefined);
});
describe("lazy shared preset fonts", () => {
  it("loads each weight once, keeps failures unavailable, and closes cached owners", async () => {
    const close = vi.fn();
    const loader = vi.fn(async (weight: 400 | 700) => {
      if (weight === 700) throw new Error("unavailable");
      return { family: "packaged400", close };
    });
    const cache = fonts.createTitlePresetFontCache(loader);
    expect(loader).not.toHaveBeenCalled();
    const first = cache.load(400);
    expect(cache.load(400)).toBe(first);
    await expect(first).resolves.toMatchObject({ family: "packaged400" });
    await expect(cache.load(700)).rejects.toThrow();
    await expect(cache.load(700)).rejects.toThrow();
    expect(loader).toHaveBeenCalledTimes(2);
    cache.close();
    cache.close();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(cache.load(400)).rejects.toThrow();
  });
  it("closes a late face after its page owner has been disposed", async () => {
    let finish!: (owner: fonts.PresetFontOwner) => void;
    const close = vi.fn();
    const cache = fonts.createTitlePresetFontCache(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = cache.load(400);
    const observed = expect(pending).rejects.toThrow();
    await Promise.resolve();
    cache.close();
    finish({ family: "late", close });
    await observed;
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("preset entry points", () => {
  it.each(["LF", "CRLF"] as const)(
    "uses the same neutral backdrop in both themes and keeps opaque sample colours visible with %s input",
    (lineEnding) => {
      // IMPORTANT: Vitest stubs CSS imports; read source bytes to prove theme declarations.
      const tokenCss = readFileSync(
        join(process.cwd(), "src/styles/tokens.css"),
        "utf8",
      )
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\r?\n/gu, lineEnding === "LF" ? "\n" : "\r\n");
      const workspaceCss = readFileSync(
        join(process.cwd(), "src/components/nle/nleWorkspace.css"),
        "utf8",
      )
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\r?\n/gu, lineEnding === "LF" ? "\n" : "\r\n");
      const themeBlocks = [
        ...tokenCss.matchAll(
          /[^{}]+\{[^{}]*--h3-well:\s*#[0-9a-f]{6};[^{}]*\}/giu,
        ),
      ];
      expect(themeBlocks).toHaveLength(2);
      for (const [block] of themeBlocks) {
        expect(
          [...block.matchAll(/--h3-preset-backdrop:\s*(#[0-9a-f]{6});/giu)].map(
            (match) => match[1],
          ),
        ).toEqual(["#767676"]);
      }
      const tile = workspaceCss.match(
        /\.h3-nle-preset canvas\s*\{([^}]+)\}/u,
      )?.[1];
      expect(tile).toMatch(/background:\s*var\(--h3-preset-backdrop\);/u);
      const luminance = (rgb: readonly number[]) =>
        rgb.reduce((sum, byte, index) => {
          const c = byte / 255;
          return (
            sum +
            [0.2126, 0.7152, 0.0722][index]! *
              (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
          );
        }, 0);
      const backdrop = luminance([118, 118, 118]);
      for (const rgb of [
        [255, 255, 255],
        [255, 255, 0],
        [0, 0, 0],
      ]) {
        const sample = luminance(rgb);
        const ratio =
          (Math.max(sample, backdrop) + 0.05) /
          (Math.min(sample, backdrop) + 0.05);
        expect(ratio).toBeGreaterThanOrEqual(3);
      }
    },
  );
  it("draws each fixed Latin sample through the real preview seam", async () => {
    const cache = fonts.createTitlePresetFontCache(async (weight) => ({
      family: `packaged${weight}`,
      close() {},
    }));
    vi.spyOn(fonts, "getTitlePresetFonts").mockReturnValue(cache);
    const view = render(
      <NleTextPresetGrid
        locale="en"
        mode="insert"
        refusal={() => undefined}
        onChoose={() => undefined}
      />,
    );
    await waitFor(() => expect(compositor.drawText).toHaveBeenCalledTimes(8));
    expect(view.getAllByRole("button")).toHaveLength(8);
    for (const call of vi.mocked(compositor.drawText).mock.calls) {
      expect(call[1].text).toMatchObject({
        content: "Title",
        fontAssetId: "h3.font.noto_sans.v1",
        style: "normal",
      });
      expect(call[2].family).toMatch(/^packaged(?:400|700)$/u);
    }
    cache.close();
  });
  it("does not paint a late font into an unmounted grid", async () => {
    const pending = new Map<number, (owner: fonts.PresetFontOwner) => void>();
    const cache = fonts.createTitlePresetFontCache(
      (weight) =>
        new Promise((resolve) => {
          pending.set(weight, resolve);
        }),
    );
    vi.spyOn(fonts, "getTitlePresetFonts").mockReturnValue(cache);
    const view = render(
      <NleTextPresetGrid
        locale="en"
        mode="insert"
        refusal={() => undefined}
        onChoose={() => undefined}
      />,
    );
    await Promise.resolve();
    view.unmount();
    expect(pending.size).toBe(2);
    for (const finish of pending.values())
      finish({ family: "late", close() {} });
    await Promise.resolve();
    expect(compositor.drawText).not.toHaveBeenCalled();
    cache.close();
  });
  it("shows localized font failure and never paints a fallback", async () => {
    const cache = fonts.createTitlePresetFontCache(async () => {
      throw new Error("unavailable");
    });
    vi.spyOn(fonts, "getTitlePresetFonts").mockReturnValue(cache);
    const view = render(
      <NleTextPresetGrid
        locale="zh-TW"
        mode="insert"
        refusal={() => undefined}
        onChoose={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(
        view.getByText("樣式預覽無法使用。", { exact: true }),
      ).toBeTruthy(),
    );
    expect(
      view
        .getAllByRole("button")
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(compositor.drawText).not.toHaveBeenCalled();
    cache.close();
  });
  it.each(["en", "zh-TW", "zh-CN"] as const)(
    "names all eight controls and associates refusals in %s",
    async (locale) => {
      const cache = fonts.createTitlePresetFontCache(async (weight) => ({
        family: `packaged${weight}`,
        close() {},
      }));
      vi.spyOn(fonts, "getTitlePresetFonts").mockReturnValue(cache);
      const choose = vi.fn();
      const view = render(
        <NleTextPresetGrid
          locale={locale}
          mode="apply"
          refusal={() => "Refused"}
          onChoose={choose}
        />,
      );
      await waitFor(() => expect(compositor.drawText).toHaveBeenCalledTimes(8));
      const buttons = view.getAllByRole("button");
      expect(buttons).toHaveLength(8);
      expect(
        new Set(buttons.map((button) => button.getAttribute("aria-label")))
          .size,
      ).toBe(8);
      for (const button of buttons) {
        expect(button.getAttribute("aria-label")).toBeTruthy();
        expect((button as HTMLButtonElement).disabled).toBe(true);
        const description = button.getAttribute("aria-describedby");
        expect(description).toBeTruthy();
        expect(document.getElementById(description!)?.textContent).toBe(
          "Refused",
        );
        fireEvent.click(button);
      }
      expect(choose).not.toHaveBeenCalled();
      cache.close();
    },
  );
  it("refuses an uncovered accepted inspector title without resetting the draft or dispatching", async () => {
    const original = snapshotFixture(SMOKE_SHAPE);
    const snapshot = {
      ...original,
      clips: original.clips.map((clip) =>
        clip.text
          ? { ...clip, text: { ...clip.text, content: "Title 😀" } }
          : clip,
      ),
    };
    const cache = fonts.createTitlePresetFontCache(async (weight) => ({
      family: `packaged${weight}`,
      close() {},
    }));
    vi.spyOn(fonts, "getTitlePresetFonts").mockReturnValue(cache);
    const onIntent = vi.fn(async (_intent: AuthoringIntent) => undefined);
    const view = render(
      <NleInspectorTabs
        locale="en"
        snapshot={snapshot}
        selection={["clip-3"]}
        authoring={authoringReady(SMOKE_SHAPE, { selection: ["clip-3"] })}
        onIntent={onIntent}
        retention={createSidebarRetention()}
      />,
    );
    fireEvent.click(view.getByRole("tab", { name: "Text" }));
    const size = view.getByRole("spinbutton", {
      name: "Size (px)",
    });
    fireEvent.change(size, { target: { value: "144" } });
    const tile = view.getByRole("button", {
      name: "Apply Caption box",
    });
    await waitFor(() => expect(compositor.drawText).toHaveBeenCalledTimes(8));
    expect((tile as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tile);
    expect(onIntent).not.toHaveBeenCalled();
    expect((size as HTMLInputElement).value).toBe("144");
    cache.close();
  });
  it("inserts a preset in one intent and retains uncovered-text refusal", async () => {
    const cache = fonts.createTitlePresetFontCache(async (weight) => ({
      family: `packaged${weight}`,
      close() {},
    }));
    vi.spyOn(fonts, "getTitlePresetFonts").mockReturnValue(cache);
    const onIntent = vi.fn(async (_intent: AuthoringIntent) => undefined);
    const view = render(
      <NleTextBin
        locale="en"
        snapshot={{ ...snapshotFixture(SMOKE_SHAPE), clips: [] }}
        busy={false}
        currentFrame={() => 18}
        onIntent={onIntent}
      />,
    );
    const button = view.getByRole("button", {
      name: "Insert Bold outline",
    });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(button);
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent.mock.calls[0]).toMatchObject([
      {
        action: "apply_timeline_commands",
        commands: [
          {
            kind: "insert_title_clip",
            payload: {
              clip: {
                start_frame: 18,
                text: { weight: 700, stroke: { width_px: 5 } },
              },
            },
          },
        ],
      },
    ]);
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "字幕😀" },
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onIntent).toHaveBeenCalledTimes(1);
    cache.close();
  });
  it("applies to the accepted style, clears optional fields, and replaces the draft coherently", async () => {
    const original = snapshotFixture(SMOKE_SHAPE);
    const snapshot = {
      ...original,
      clips: original.clips.map((clip) =>
        clip.text
          ? {
              ...clip,
              text: {
                ...clip.text,
                stroke: { rgba: [0, 255, 0, 255] as const, widthPx: 9 },
                shadow: {
                  rgba: [1, 2, 3, 255] as const,
                  offsetXPx: 7,
                  offsetYPx: 8,
                },
              },
            }
          : clip,
      ),
    };
    const cache = fonts.createTitlePresetFontCache(async (weight) => ({
      family: `packaged${weight}`,
      close() {},
    }));
    vi.spyOn(fonts, "getTitlePresetFonts").mockReturnValue(cache);
    const onIntent = vi.fn(async (_intent: AuthoringIntent) => undefined);
    const view = render(
      <NleInspectorTabs
        locale="en"
        snapshot={snapshot}
        selection={["clip-3"]}
        authoring={authoringReady(SMOKE_SHAPE, { selection: ["clip-3"] })}
        onIntent={onIntent}
        retention={createSidebarRetention()}
      />,
    );
    fireEvent.click(view.getByRole("tab", { name: "Text" }));
    fireEvent.change(view.getByRole("spinbutton", { name: "Size (px)" }), {
      target: { value: "144" },
    });
    const button = view.getByRole("button", {
      name: "Apply Caption box",
    });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(button);
    expect(onIntent).toHaveBeenCalledTimes(1);
    const expected = applyPreset(
      textStyleWire(snapshot.clips.find((c) => c.clipId === "clip-3")!)!,
      TEXT_PRESETS.find((p) => p.id === "captionBox")!,
    );
    expect(onIntent.mock.calls[0]).toMatchObject([
      {
        action: "apply_timeline_commands",
        commands: [
          {
            kind: "set_text_style",
            payload: { clip_id: "clip-3", style: expected },
          },
        ],
      },
    ]);
    const commands = (
      onIntent.mock.calls[0] as unknown as [{ commands: unknown[] }]
    )[0].commands;
    expect(commands).toHaveLength(1);
    expect(
      (
        view.getByRole("spinbutton", {
          name: "Size (px)",
        }) as HTMLInputElement
      ).value,
    ).toBe(String(expected.size_px));
    cache.close();
  });
});
