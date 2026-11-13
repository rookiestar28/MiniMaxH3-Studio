// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_STYLE } from "../src/components/nle/nleCommandBuilders";
import { planTitleInsertion } from "../src/components/nle/nleTitleInsertion";
import { SMOKE_SHAPE, snapshotFixture } from "./support/nleWorkspaceFixture";
import {
  applyPreset,
  TEXT_PRESETS,
} from "../src/components/nle/nleTextPresets";
import {
  decodePublicCompositionSnapshot,
  publicCompositionFingerprint,
} from "../src/contracts/compositionCodec";
import compositionFixture from "../../tests/fixtures/m25_10_composition_contract_v1.json";
import { textStyleWire } from "../src/components/nle/nleCommandBuilders";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("frozen title catalogue", () => {
  it("emits the shared cross-end fixture deterministically without rewriting it", () => {
    const fixture = readFileSync(
      new URL("../../tests/fixtures/title_style_presets.json", import.meta.url),
      "utf8",
    );
    const generator = fileURLToPath(
      new URL("./support/generateTitlePresetFixture.ts", import.meta.url),
    );
    const emit = () =>
      execFileSync(process.execPath, [generator], { encoding: "utf8" });
    expect(emit()).toBe(fixture);
    expect(emit()).toBe(fixture);
    expect(JSON.parse(fixture)).toEqual(TEXT_PRESETS);
  });
  it("has eight distinct normal-style presets with frozen nested values", () => {
    expect(TEXT_PRESETS).toHaveLength(8);
    expect(new Set(TEXT_PRESETS.map((preset) => preset.id)).size).toBe(8);
    expect(Object.isFrozen(TEXT_PRESETS)).toBe(true);
    for (const preset of TEXT_PRESETS) {
      expect(preset.style.style).toBe("normal");
      expect(Object.isFrozen(preset.style)).toBe(true);
      expect(Object.isFrozen(preset.style.fill_rgba)).toBe(true);
      for (const key of [
        "font_asset_id",
        "size_px",
        "align",
        "line_height_bp",
        "content",
      ])
        expect(preset.style).not.toHaveProperty(key);
    }
  });
  it.each([
    "outline",
    "outlineYellow",
    "dropShadow",
    "outlineShadow",
    "captionBox",
    "highlight",
    "inverseBox",
    "boldOutline",
  ])("decodes %s through the public frontend codec", (id) => {
    const preset = TEXT_PRESETS.find((row) => row.id === id)!;
    const source = structuredClone(compositionFixture.snapshot);
    const original = source.clips[3]!.text!;
    const accepted = decodePublicCompositionSnapshot(source);
    const style = applyPreset(textStyleWire(accepted.clips[3]!)!, preset);
    const wire = {
      ...source,
      clips: source.clips.map((clip, index) =>
        index === 3
          ? { ...clip, text: { ...style, content: original.content } }
          : clip,
      ),
    };
    wire.public_fingerprint = publicCompositionFingerprint(wire);
    const decoded = decodePublicCompositionSnapshot(wire);
    const { content: _content, ...expected } = wire.clips[3]!.text!;
    expect(textStyleWire(decoded.clips[3]!)).toEqual(expected);
  });
  it("replaces optional decorations rather than retaining a previous preset", () => {
    const base = {
      ...DEFAULT_TEXT_STYLE,
      font_asset_id: "h3.font.noto_sans.v1",
      size_px: 91,
      align: "left" as const,
      line_height_bp: 17000,
      content: "Kept content",
    };
    const outlined = applyPreset(
      base,
      TEXT_PRESETS.find((p) => p.id === "boldOutline")!,
    );
    const boxed = applyPreset(
      outlined,
      TEXT_PRESETS.find((p) => p.id === "captionBox")!,
    );
    expect(boxed).toMatchObject({
      font_asset_id: base.font_asset_id,
      size_px: 91,
      align: "left",
      line_height_bp: 17000,
      content: "Kept content",
      background_rgba: [0, 0, 0, 153],
      background_padding_px: 8,
      weight: 400,
    });
    expect(boxed).not.toHaveProperty("stroke");
    expect(boxed).not.toHaveProperty("shadow");
    const shadow = applyPreset(
      boxed,
      TEXT_PRESETS.find((p) => p.id === "dropShadow")!,
    );
    expect(shadow.background_rgba).toBeNull();
    expect(shadow).not.toHaveProperty("background_padding_px");
    expect(shadow).not.toHaveProperty("stroke");
    expect(shadow.shadow).toEqual({
      rgba: [0, 0, 0, 128],
      offset_x_px: 3,
      offset_y_px: 3,
    });
    expect(base).not.toHaveProperty("shadow");
  });
});

describe("preset insertion transaction", () => {
  it.each([false, true])(
    "carries the whole style in the insert payload (allocate=%s)",
    (allocate) => {
      const original = snapshotFixture(SMOKE_SHAPE);
      const authority = {
        ...original,
        clips: [],
        tracks: allocate
          ? original.tracks.filter((track) => track.kind !== "text_overlay")
          : original.tracks,
      };
      const fontId = authority.assets.find(
        (asset) => asset.kind === "font",
      )!.assetId;
      const style = {
        ...DEFAULT_TEXT_STYLE,
        font_asset_id: fontId,
        weight: 700 as const,
        stroke: { rgba: [0, 0, 0, 255] as const, width_px: 5 },
        shadow: {
          rgba: [0, 0, 0, 102] as const,
          offset_x_px: 2,
          offset_y_px: 2,
        },
      };
      const decision = planTitleInsertion(authority, {
        busy: false,
        frame: 0,
        fontId,
        content: "Title",
        style,
      });
      expect(decision.admitted).toBe(true);
      if (!decision.admitted) throw new Error("expected insertion");
      expect(decision.intent.action).toBe("apply_timeline_commands");
      expect(decision.intent.commands.map((command) => command.kind)).toEqual(
        allocate
          ? ["create_track", "insert_title_clip"]
          : ["insert_title_clip"],
      );
      expect(decision.intent.commands.at(-1)).toMatchObject({
        payload: { clip: { text: { ...style, content: "Title" } } },
      });
    },
  );

  it("refuses CJK italic before allocating a track", () => {
    const original = snapshotFixture(SMOKE_SHAPE);
    const authority = {
      ...original,
      clips: [],
      tracks: original.tracks.filter((track) => track.kind !== "text_overlay"),
    };
    const fontId = authority.assets.find(
      (asset) => asset.kind === "font",
    )!.assetId;
    const result = planTitleInsertion(authority, {
      busy: false,
      frame: 0,
      fontId,
      content: "字幕",
      style: { ...DEFAULT_TEXT_STYLE, font_asset_id: fontId, style: "italic" },
    });
    expect(result).toEqual({
      admitted: false,
      reason: "font_italic_unsupported",
    });
  });
});
