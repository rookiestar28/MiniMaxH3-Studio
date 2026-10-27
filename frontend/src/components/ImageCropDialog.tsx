import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SeamResult } from "../host/hostSeams";
import { createHostThemeController } from "../host/hostTheme";
import type {
  CropSourceImage,
  ImageCropSourceActions,
} from "../host/imageCropSource";
import {
  applyRatio,
  fullImageCrop,
  isFullImageCrop,
  moveCrop,
  reducedRatio,
  resizeCrop,
  type CropHandle,
  type CropRatio,
  type ImageCrop,
} from "../host/imageCropGeometry";
import type { sidebarCopy } from "../i18n/catalog";

export type ImageCropBinding = Readonly<{
  available: boolean;
  actions: ImageCropSourceActions;
  acquireKeyboardGuard(
    onInvalidated: () => void,
  ): SeamResult<Readonly<{ release(): void }>>;
}>;
type Copy = ReturnType<typeof sidebarCopy>["crop"];
const HANDLES: readonly CropHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];
const RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
] as const;
const sameCrop = (a: ImageCrop, b: ImageCrop) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export function ImageCropDialog({
  sourceId,
  initialCrop,
  text,
  actions,
  acquireKeyboardGuard,
  onClose,
}: {
  sourceId: string;
  initialCrop?: ImageCrop;
  text: Copy;
  actions: ImageCropSourceActions;
  acquireKeyboardGuard: ImageCropBinding["acquireKeyboardGuard"];
  onClose(crop?: ImageCrop): void;
}) {
  const titleId = useId();
  const helpId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const themeRoot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (themeRoot.current !== null)
      return createHostThemeController(themeRoot.current);
  }, []);
  const imageBox = useRef<HTMLDivElement>(null);
  const release = useRef<() => void>(() => {});
  const [source, setSource] = useState<CropSourceImage>();
  const [crop, setCrop] = useState<ImageCrop>();
  const baseline = useRef<ImageCrop | undefined>(undefined);
  const [ratioKey, setRatioKey] = useState("free");
  const [error, setError] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const drag = useRef<
    | {
        x: number;
        y: number;
        crop: ImageCrop;
        handle?: CropHandle;
      }
    | undefined
  >(undefined);
  const callbacks = useRef({ actions, acquireKeyboardGuard, onClose });
  callbacks.current = { actions, acquireKeyboardGuard, onClose };
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const lease = callbacks.current.acquireKeyboardGuard(() => {
      setError(true);
      release.current();
    });
    let released = false;
    release.current = () => {
      if (released) return;
      released = true;
      if (lease.status === "ready") lease.value.release();
    };
    if (lease.status !== "ready") setError(true);
    dialog.current?.focus();
    return () => {
      release.current();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  useLayoutEffect(() => {
    // IMPORTANT: removing Keep editing or failed controls drops focus outside the
    // open modal. Refocus it so Escape/Tab and canvas shortcut containment still work,
    // including after the error path has released the host keyboard lease.
    dialog.current?.focus();
  }, [discarding, error]);
  useEffect(() => {
    if (error) return;
    let live = true;
    void callbacks.current.actions
      .open(sourceId)
      .then((image) => {
        if (!live) return;
        const initial =
          initialCrop?.sourceWidth === image.width &&
          initialCrop.sourceHeight === image.height
            ? initialCrop
            : fullImageCrop(image.width, image.height);
        baseline.current = initial;
        setSource(image);
        setCrop(initial);
      })
      .catch(() => {
        if (live) {
          setError(true);
          release.current();
        }
      });
    return () => {
      live = false;
    };
  }, [sourceId, error, initialCrop]);
  const ratio = (key: string): CropRatio | undefined => {
    if (key === "free" || source === undefined) return undefined;
    if (key === "original") return reducedRatio(source.width, source.height);
    const [p, q] = key.split(":").map(Number);
    return [p!, q!];
  };
  const requestClose = () => {
    if (crop && baseline.current && !sameCrop(crop, baseline.current))
      setDiscarding(true);
    else {
      release.current();
      callbacks.current.onClose();
    }
  };
  return createPortal(
    <div data-h3-context-mount="" className="h3-crop-portal">
      <div className="h3c h3-crop-backdrop" ref={themeRoot}>
        <div
          ref={dialog}
          className="h3-crop-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={helpId}
          tabIndex={-1}
          onKeyDown={(event) => {
            // IMPORTANT: the host leases stop canvas shortcuts; stop bubbling here
            // too, so dialog arrows never reach document-level editor listeners.
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              requestClose();
            }
            if (event.key === "Tab") {
              const controls = [
                ...(dialog.current?.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), select:not(:disabled), [tabindex="0"]',
                ) ?? []),
              ];
              const first = controls[0];
              const last = controls.at(-1);
              if (
                event.shiftKey &&
                (document.activeElement === first ||
                  document.activeElement === dialog.current)
              ) {
                event.preventDefault();
                last?.focus();
              } else if (
                !event.shiftKey &&
                (document.activeElement === last ||
                  document.activeElement === dialog.current)
              ) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <h2 id={titleId}>{text.title}</h2>
          <p id={helpId}>{text.help}</p>
          {error ? (
            <p role="alert">{text.failed}</p>
          ) : source && crop ? (
            <>
              <label>
                {text.aspectRatio}
                <select
                  aria-label={text.aspectRatio}
                  value={ratioKey}
                  onChange={(event) => {
                    const key = event.currentTarget.value;
                    const nextRatio = ratio(key);
                    const next = nextRatio
                      ? applyRatio(crop, ...nextRatio)
                      : crop;
                    if (next) {
                      setRatioKey(key);
                      setCrop(next);
                    }
                  }}
                >
                  {["free", "original", ...RATIOS].map((key) => {
                    const nextRatio = ratio(key);
                    const disabled =
                      nextRatio !== undefined &&
                      applyRatio(crop, ...nextRatio) === undefined;
                    return (
                      <option key={key} value={key} disabled={disabled}>
                        {key === "free"
                          ? text.free
                          : key === "original"
                            ? text.original
                            : key}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div
                ref={imageBox}
                className="h3-crop-image"
                style={{
                  aspectRatio: `${source.width}/${source.height}`,
                  width: `min(100%, ${(55 * source.width) / source.height}dvh)`,
                }}
              >
                <img
                  src={source.url}
                  alt=""
                  draggable={false}
                  onError={() => {
                    setError(true);
                    release.current();
                  }}
                />
                <div
                  className="h3-crop-region"
                  role="group"
                  aria-label={text.regionLabel}
                  tabIndex={0}
                  style={{
                    left: `${(100 * crop.x) / source.width}%`,
                    top: `${(100 * crop.y) / source.height}%`,
                    width: `${(100 * crop.w) / source.width}%`,
                    height: `${(100 * crop.h) / source.height}%`,
                  }}
                  onKeyDown={(event) => {
                    const delta = event.shiftKey ? 10 : 1;
                    const dx =
                      event.key === "ArrowLeft"
                        ? -delta
                        : event.key === "ArrowRight"
                          ? delta
                          : 0;
                    const dy =
                      event.key === "ArrowUp"
                        ? -delta
                        : event.key === "ArrowDown"
                          ? delta
                          : 0;
                    if (!dx && !dy) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const handle = (event.target as HTMLElement).dataset
                      .cropHandle as CropHandle | undefined;
                    setCrop(
                      handle
                        ? resizeCrop(
                            crop,
                            handle,
                            dx,
                            dy,
                            ratio(ratioKey),
                            "keyboard",
                          )
                        : moveCrop(crop, dx, dy),
                    );
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = {
                      x: event.clientX,
                      y: event.clientY,
                      crop,
                      handle: (event.target as HTMLElement).dataset
                        .cropHandle as CropHandle | undefined,
                    };
                  }}
                  onPointerMove={(event) => {
                    const start = drag.current;
                    const bounds = imageBox.current?.getBoundingClientRect();
                    if (!start || !bounds?.width || !bounds.height) return;
                    const dx = Math.round(
                      ((event.clientX - start.x) * source.width) / bounds.width,
                    );
                    const dy = Math.round(
                      ((event.clientY - start.y) * source.height) /
                        bounds.height,
                    );
                    setCrop(
                      start.handle
                        ? resizeCrop(
                            start.crop,
                            start.handle,
                            dx,
                            dy,
                            ratio(ratioKey),
                          )
                        : moveCrop(start.crop, dx, dy),
                    );
                  }}
                  onPointerUp={(event) => {
                    drag.current = undefined;
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                  }}
                  onPointerCancel={() => {
                    drag.current = undefined;
                  }}
                >
                  {HANDLES.map((handle) => (
                    <button
                      key={handle}
                      type="button"
                      className={`h3-crop-handle h3-crop-${handle}`}
                      data-crop-handle={handle}
                      aria-label={text.handles[handle]}
                    />
                  ))}
                </div>
              </div>
              <output aria-live="polite">
                {crop.w} × {crop.h} · {crop.x}, {crop.y}
              </output>
            </>
          ) : (
            <p role="status">{text.loading}</p>
          )}
          {discarding ? (
            <div role="alert">
              <p>{text.dirty}</p>
              <button
                type="button"
                onClick={() => {
                  release.current();
                  callbacks.current.onClose();
                }}
              >
                {text.discard}
              </button>
              <button type="button" onClick={() => setDiscarding(false)}>
                {text.keep}
              </button>
            </div>
          ) : null}
          <div className="h3-crop-actions">
            <button
              type="button"
              disabled={!source || error}
              onClick={() => {
                if (source) {
                  setRatioKey("free");
                  setCrop(fullImageCrop(source.width, source.height));
                }
              }}
            >
              {text.reset}
            </button>
            <button
              type="button"
              disabled={!crop || error}
              onClick={() => {
                if (!crop) return;
                const applied = isFullImageCrop(crop) ? undefined : crop;
                try {
                  callbacks.current.actions.apply(sourceId, applied);
                  release.current();
                  callbacks.current.onClose(applied);
                } catch {
                  setError(true);
                  release.current();
                }
              }}
            >
              {text.apply}
            </button>
            <button type="button" onClick={requestClose}>
              {text.cancel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
