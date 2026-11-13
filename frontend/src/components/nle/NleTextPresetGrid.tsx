import { useCallback, useEffect, useId, useState } from "react";
import type { Locale } from "../../i18n/catalog";
import { drawText } from "../../runtime/visualCompositor";
import { nleCopy, fill } from "./nleCopy";
import {
  getTitlePresetFonts,
  type PresetFontOwner,
} from "./nleTextPresetFonts";
import { TEXT_PRESETS, type TextPreset } from "./nleTextPresets";
export type NleTextPresetGridProps = Readonly<{
  locale: Locale;
  mode: "insert" | "apply";
  refusal(preset: TextPreset): string | undefined;
  onChoose(preset: TextPreset): void;
  selected?(preset: TextPreset): boolean;
}>;
type Faces = Readonly<Record<400 | 700, PresetFontOwner>>;

function PresetSample({
  preset,
  faces,
  onFailure,
}: {
  preset: TextPreset;
  faces: Faces;
  onFailure(): void;
}) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (canvas === null) return;
    try {
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("canvas unavailable");
      const style = preset.style;
      context.clearRect(0, 0, 256, 96);
      drawText(
        context,
        {
          clipId: "preset-sample",
          assetId: null,
          trackId: "preset-sample",
          sourceFrame: null,
          sourcePts: null,
          transitionElapsedFrames: null,
          operationIds: [],
          transform: {},
          crop: {},
          opacityBp: 10000,
          blend: "normal",
          effect: {},
          text: {
            content: "Title",
            fontAssetId: "h3.font.noto_sans.v1",
            sizePx: 36,
            weight: style.weight,
            style: style.style,
            align: "center",
            lineHeightBp: 12000,
            fillRgba: style.fill_rgba,
            backgroundRgba: style.background_rgba,
            ...(style.stroke
              ? {
                  stroke: {
                    rgba: style.stroke.rgba,
                    widthPx: style.stroke.width_px,
                  },
                }
              : {}),
            ...(style.shadow
              ? {
                  shadow: {
                    rgba: style.shadow.rgba,
                    offsetXPx: style.shadow.offset_x_px,
                    offsetYPx: style.shadow.offset_y_px,
                  },
                }
              : {}),
            ...(style.background_padding_px === undefined
              ? {}
              : { backgroundPaddingPx: style.background_padding_px }),
          },
        },
        { kind: "font", family: faces[style.weight].family },
        {
          nativeCrop: { left: 0, top: 0, width: 256, height: 96 },
          sourceCrop: { left: 0, top: 0, width: 256, height: 96 },
          scaledWidth: 256,
          scaledHeight: 96,
          angleRadians: 0,
          centerX: 128,
          centerY: 48,
        },
        256,
        96,
        1,
      );
    } catch {
      onFailure();
    }
  }, [canvas, preset, faces, onFailure]);
  return <canvas ref={setCanvas} width={256} height={96} aria-hidden="true" />;
}

export function NleTextPresetGrid({
  locale,
  mode,
  refusal,
  onChoose,
  selected,
}: NleTextPresetGridProps) {
  const copy = nleCopy(locale).presets;
  const prefix = useId();
  const [cache] = useState(getTitlePresetFonts);
  const [faces, setFaces] = useState<Faces | null>(null);
  const [failed, setFailed] = useState(cache === null);
  const onFailure = useCallback(() => setFailed(true), []);
  useEffect(() => {
    if (cache === null) return;
    let active = true;
    void Promise.all([cache.load(400), cache.load(700)])
      .then(([regular, bold]) => {
        // IMPORTANT: a shared page font can finish after this grid unmounts. Only the page
        // owns its lifetime; this grid must neither paint late nor close another grid's face.
        if (active) setFaces({ 400: regular, 700: bold });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [cache]);
  const readiness = failed
    ? copy.unavailable
    : faces === null
      ? copy.loading
      : undefined;
  const reasons = new Map<string, string>();
  const entries = TEXT_PRESETS.map((preset) => {
    const reason = readiness ?? refusal(preset);
    if (reason !== undefined && !reasons.has(reason))
      reasons.set(reason, `${prefix}-${reasons.size}`);
    return { preset, reason, isSelected: selected?.(preset) ?? false };
  });
  return (
    <section className="h3-nle-presets" aria-label={copy.heading}>
      <h4>{copy.heading}</h4>
      <div className="h3-nle-preset-grid">
        {entries.map(({ preset, reason, isSelected }) => (
          <button
            key={preset.id}
            type="button"
            className="h3-nle-preset"
            data-h3-nle-control={
              mode === "insert" ? "title.insert_preset" : "text.apply_preset"
            }
            data-h3-nle-preset={preset.id}
            aria-label={fill(copy[mode], { name: copy.names[preset.id] })}
            aria-pressed={mode === "apply" ? isSelected : undefined}
            aria-describedby={
              reason === undefined ? undefined : reasons.get(reason)
            }
            disabled={reason !== undefined || isSelected}
            onClick={() => {
              if (reason === undefined && !isSelected) onChoose(preset);
            }}
          >
            {!failed && faces !== null && (
              <PresetSample
                preset={preset}
                faces={faces}
                onFailure={onFailure}
              />
            )}
            <span>{copy.names[preset.id]}</span>
          </button>
        ))}
      </div>
      {[...reasons].map(([reason, id]) => (
        <p key={reason} id={id} className="h3-nle-note">
          {reason}
        </p>
      ))}
    </section>
  );
}
