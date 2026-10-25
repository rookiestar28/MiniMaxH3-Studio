import { useState } from "react";
import {
  H3Sidebar,
  initialAppModeDraft,
  type AppModeDraft,
} from "../src/components/H3Sidebar";
import { SUPPORTED_LOCALES, type Locale } from "../src/i18n/catalog";
import { initialShellState } from "../src/state/shellState";
import { createImageCropSources } from "../src/host/imageCropSource";
import { seamReady } from "../src/host/hostSeams";
import { fixtureBackedAppModeApi } from "../tests/support/hostSeamTestDouble";

const mediaSources = (["image", "video", "audio"] as const).flatMap(
  (kind, group) =>
    Array.from({ length: kind === "image" ? 10 : 4 }, (_, index) => ({
      kind,
      output_slot: 0 as const,
      node_id: String(10 + group * 20 + index),
      label: `Synthetic ${kind} source ${index + 1} with a deliberately long visible name`,
    })),
);
const empty: AppModeDraft = { ...initialAppModeDraft, taskMode: "ref2va" };
export function ReferencePickerHarness({ crop = false }: { crop?: boolean }) {
  const [locale, setLocale] = useState<Locale>("en");
  const [draft, setDraft] = useState(empty);
  const [starts, setStarts] = useState(0);
  const [payload, setPayload] = useState("");
  const [leases, setLeases] = useState(0);
  const [cropAvailable, setCropAvailable] = useState(true);
  const [cropSources] = useState(() =>
    createImageCropSources({
      api: fixtureBackedAppModeApi({ fileURL: (path: string) => path }),
      readGraph: () => ({
        nodes: mediaSources
          .filter((source) => source.kind === "image")
          .map((source) => ({
            id: Number(source.node_id),
            type: "LoadImage",
            widgets_values: ["crop-fixture.png"],
          })),
      }),
    }),
  );
  return (
    <>
      <label>
        Picker locale{" "}
        <select
          aria-label="Picker locale"
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {SUPPORTED_LOCALES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        Picker preset{" "}
        <select
          aria-label="Picker preset"
          defaultValue="empty"
          onChange={(event) => {
            const value = event.target.value;
            setDraft({
              ...empty,
              referenceImages:
                value === "sample"
                  ? ["10", "11", "12"]
                  : value === "overflow"
                    ? Array.from({ length: 9 }, (_, i) => String(10 + i))
                    : [],
              referenceVideos:
                value === "sample"
                  ? ["30", "31"]
                  : value === "overflow"
                    ? ["30", "31", "32"]
                    : [],
              referenceAudios:
                value === "sample" || value === "audio-only" ? ["50"] : [],
            });
          }}
        >
          <option>empty</option>
          <option>sample</option>
          <option>audio-only</option>
          <option>overflow</option>
        </select>
      </label>
      <output id="reference-picker-starts">{starts}</output>
      {crop ? (
        <>
          <label>
            Crop available
            <input
              type="checkbox"
              checked={cropAvailable}
              onChange={(event) =>
                setCropAvailable(event.currentTarget.checked)
              }
            />
          </label>
          <output id="crop-guard-leases">{leases}</output>
          <output id="crop-request">{payload}</output>
        </>
      ) : null}
      <div id="reference-picker-sidebar" style={{ width: "100%" }}>
        <H3Sidebar
          locale={locale}
          state={initialShellState}
          appModeDraft={draft}
          onAppModeDraftChange={setDraft}
          appMode={{
            ...(crop
              ? {
                  imageCrop: {
                    available: cropAvailable,
                    actions: cropSources,
                    acquireKeyboardGuard: () => {
                      setLeases((n) => n + 1);
                      let released = false;
                      return seamReady({
                        release() {
                          if (!released) {
                            released = true;
                            setLeases((n) => n - 1);
                          }
                        },
                      });
                    },
                  },
                }
              : {}),
            capability: { status: "ready" },
            mediaSources,
            imageSources: mediaSources.filter(
              (source) => source.kind === "image",
            ),
            durationResolution: {
              status: "resolved",
              resolution: {
                schema: "h3.context.duration_resolution.v1",
                requested_seconds: 5,
                requested_milliseconds: 5000,
                effective_milliseconds: 5167,
                frame_count: 124,
                snapped: true,
              },
            },
            onStart: (inputs) => {
              setPayload(JSON.stringify(inputs));
              setStarts((value) => value + 1);
            },
            onCancel: () => {},
          }}
        />
      </div>
    </>
  );
}
