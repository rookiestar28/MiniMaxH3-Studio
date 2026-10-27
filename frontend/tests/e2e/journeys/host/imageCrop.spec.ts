import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { sidebarCopy } from "../../../../src/i18n/catalog";
import {
  decodeComfyPromptHistory,
  decodeComfyPromptHistorySavedVideos,
} from "../../../../src/host/comfyPromptHistory";
import { expect, test, type Page } from "../../host/fixture";
import { assertCropWeightSampleGeometry } from "../../../support/cropWeightSampleGeometry";
import {
  assertCandidateBundleInjection,
  candidateInjectionCount,
  hostUrl,
  officialAssetManifest,
  openH3AppModeTab,
  waitForH3Registration,
  waitForHostGraphSettled,
} from "../../host/environment";

type Prompt = Record<
  string,
  { class_type: string; inputs: Record<string, any> }
>;
type Fixture = { images: [string, string] };
const text = sidebarCopy("en");
const expectedCrops = [
  { x: 80, y: 0, width: 480, height: 480 },
  { x: 27, y: 1, width: 426, height: 639 },
];

function fixture(): Fixture {
  const path = process.env.H3_CONTEXT_REFERENCE_MEDIA_FIXTURE;
  if (!path) throw new Error("explicit synthetic crop fixture required");
  const value = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  if (
    !Array.isArray(value.images) ||
    value.images.length !== 2 ||
    new Set(value.images).size !== 2 ||
    value.images.some(
      (name) => typeof name !== "string" || /[\r\n\0]/.test(name),
    )
  )
    throw new Error("synthetic crop fixture malformed");
  return value;
}

async function prepare(page: Page, mode: "ref2va" | "fl2va") {
  if (!hostUrl) throw new Error("supplied host required");
  await page.goto(hostUrl, { waitUntil: "domcontentloaded" });
  await waitForH3Registration(page);
  await waitForHostGraphSettled(page);
  await page.evaluate(async (images) => {
    const app = (window as any).comfyAPI.app.app;
    await app.loadApiJson(
      Object.fromEntries(
        images.map((image, i) => [
          String(17 + i),
          { class_type: "LoadImage", inputs: { image } },
        ]),
      ),
      "synthetic-crop-sources",
    );
  }, fixture().images);
  const container = await openH3AppModeTab(page, "h3-crop-host-panel");
  await container.getByLabel(text.taskMode, { exact: true }).selectOption(mode);
  await container
    .getByRole("textbox", { name: text.intent, exact: true })
    .fill("A colorful kite crosses a clear sky.");
  await container
    .getByRole("spinbutton", { name: text.durationSeconds })
    .fill("5");
  if (mode === "ref2va") {
    const choices = container.getByRole("combobox", {
      name: text.referenceImages,
      exact: true,
    });
    await expect
      .poll(() => choices.locator("option").count())
      .toBeGreaterThan(2);
    await choices.selectOption("17");
    await choices.selectOption("18");
  } else {
    await container
      .getByRole("combobox", { name: text.firstFrameSource, exact: true })
      .selectOption("17");
    await container
      .getByRole("combobox", { name: text.lastFrameSource, exact: true })
      .selectOption("18");
  }
  const viewStatuses: number[] = [];
  const pageErrors: string[] = [];
  const viewResponse = (response: import("@playwright/test").Response) => {
    const url = new URL(response.url());
    if (url.origin === hostUrl && url.pathname.endsWith("/view"))
      viewStatuses.push(Math.floor(response.status() / 100));
  };
  const pageError = (error: Error) => {
    pageErrors.push(
      [
        "Error",
        "TypeError",
        "ReferenceError",
        "SyntaxError",
        "RangeError",
      ].includes(error.name)
        ? error.name
        : "Other",
    );
  };
  page.on("response", viewResponse);
  page.on("pageerror", pageError);
  for (const [i, ratio] of ["1:1", "2:3"].entries()) {
    viewStatuses.length = 0;
    await container
      .getByRole("button", { name: text.crop.action, exact: true })
      .nth(i)
      .click();
    const admission = await page.evaluate((images) => {
      const app = (window as any).comfyAPI.app.app;
      const canvas = app.canvas;
      const modal = Object.getOwnPropertyDescriptor(
        app.constructor,
        "maskeditor_is_opended",
      );
      const nodes = app.graph.serialize().nodes;
      return {
        modalTier:
          modal !== undefined &&
          "value" in modal &&
          modal.configurable === true &&
          modal.writable === true &&
          (modal.value === null || typeof modal.value === "function")
            ? "data"
            : typeof modal?.get === "function" &&
                typeof modal.set === "function"
              ? "accessor"
              : "absent",
        canvas:
          canvas?.canvas instanceof HTMLCanvasElement &&
          canvas.canvas.ownerDocument === document &&
          document.defaultView !== null &&
          canvas._events_binded === true &&
          typeof canvas._key_callback === "function" &&
          ((canvas._ghostKeyHandler === null &&
            canvas.state?.ghostNodeId === null) ||
            (typeof canvas._ghostKeyHandler === "function" &&
              (typeof canvas.state?.ghostNodeId === "string" ||
                (typeof canvas.state?.ghostNodeId === "number" &&
                  Number.isFinite(canvas.state.ghostNodeId))))),
        sources: images.map(
          (image, index) =>
            nodes.find((node: any) => String(node.id) === String(17 + index))
              ?.widgets_values?.[0] === image,
        ),
      };
    }, fixture().images);
    const dialog = page.getByRole("dialog", { name: text.crop.title });
    // The second fixture stores 640x480 with EXIF orientation 6: browser and
    // LoadImage must agree on the decoded 480x640 before any rectangle is applied.
    try {
      await expect(dialog.locator("output")).toHaveText(
        i === 0 ? "640 × 480 · 0, 0" : "480 × 640 · 0, 0",
      );
    } catch {
      // Retain only content-free failure facts, never DOM text, URLs or console payloads.
      const facts = await page.evaluate(() => {
        const dialog = document.querySelector(".h3-crop-dialog");
        const image = dialog?.querySelector("img");
        return {
          dialogs: document.querySelectorAll(".h3-crop-dialog").length,
          error: Boolean(dialog?.querySelector('[role="alert"]')),
          output: Boolean(dialog?.querySelector("output")),
          image: image !== null && image !== undefined,
          decoded: image ? [image.naturalWidth, image.naturalHeight] : null,
        };
      });
      throw new Error(
        `crop_open_failed:${JSON.stringify({ ...facts, viewStatusClasses: viewStatuses.slice(-4), admission, pageErrors: pageErrors.slice(-4) })}`,
      );
    }
    await dialog
      .getByRole("combobox", { name: text.crop.aspectRatio })
      .selectOption(ratio);
    await dialog
      .getByRole("button", { name: text.crop.apply, exact: true })
      .click();
  }
  page.off("response", viewResponse);
  page.off("pageerror", pageError);
  const submit = container.getByRole("button", {
    // The two source loaders make this a nonempty, unowned canvas. Preparation
    // explicitly replaces it; the empty-canvas Start action is not rendered.
    name: text.replaceAppMode,
    exact: true,
  });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).comfyAPI.app.app.graph._nodes.filter(
            (node: any) => node.type === "ImageCropV2",
          ).length,
      ),
    )
    .toBe(2);
  await expect(
    container.locator('[data-app-mode-state="working"]'),
  ).toHaveCount(0);
  await waitForHostGraphSettled(page);
  // A prepared canvas can immediately become native_preference after the next
  // census. Inspect the native compiler, rather than a transient sidebar status.
  const prompt = (await page.evaluate(
    async () => (await (window as any).comfyAPI.app.app.graphToPrompt()).output,
  )) as Prompt;
  const crops = Object.entries(prompt).filter(
    ([, node]) => node.class_type === "ImageCropV2",
  );
  expect(crops).toHaveLength(2);
  for (const [i, [, crop]] of crops.entries()) {
    expect(crop.inputs.crop_region).toEqual(expectedCrops[i]);
    expect(prompt[String(crop.inputs.image[0])]?.class_type).toBe("LoadImage");
  }
  const registry = Object.values(prompt).find(
    (node) =>
      node.class_type === "comfyui_h3_context.H3Context.ReferenceRegistry",
  )!;
  const native = Object.values(prompt).find(
    (node) =>
      node.class_type ===
      (mode === "ref2va"
        ? "MiniMaxH3ReferenceToVideo"
        : "MiniMaxH3ImageToVideo"),
  )!;
  expect(registry).toBeDefined();
  expect(native).toBeDefined();
  for (const [i, [id]] of crops.entries()) {
    expect(
      registry.inputs[
        mode === "ref2va"
          ? `images.image${i}`
          : i === 0
            ? "first_frame"
            : "last_frame"
      ],
    ).toEqual([id, 0]);
    expect(
      native.inputs[
        mode === "ref2va"
          ? `ref_images.ref_image_${i}`
          : i === 0
            ? "first_frame"
            : "last_frame"
      ],
    ).toEqual([id, 0]);
  }
  return { prompt, crops };
}

async function execute(
  request: APIRequestContext,
  prompt: Prompt,
  timeout: number,
) {
  const queued = await request.post(`${hostUrl}/prompt`, { data: { prompt } });
  expect(queued.ok(), "native prompt admission").toBe(true);
  const id = (await queued.json()).prompt_id as string;
  expect(typeof id).toBe("string");
  let history: any;
  await expect
    .poll(
      async () => {
        history = (
          await (await request.get(`${hostUrl}/history/${id}`)).json()
        )[id];
        return history?.status !== undefined;
      },
      { timeout, intervals: [1000, 2000, 5000] },
    )
    .toBe(true);
  expect(history.status.status_str, "native execution disposition").toBe(
    "success",
  );
  expect(history.status.completed).toBe(true);
  return { history, id };
}

test("supplied host compiles and executes crop regions with EXIF and Registry preview", async ({
  page,
  context,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const injection = candidateInjectionCount(context);
  const { prompt, crops } = await prepare(page, "ref2va");
  await assertCandidateBundleInjection(page, context, injection);
  const preview = Object.entries(prompt).find(
    ([, node]) => node.class_type === "comfyui_h3_context.H3Context.Preview",
  );
  expect(preview).toBeDefined();
  const selected: Prompt = {};
  const visit = (id: string) => {
    if (selected[id]) return;
    const node = prompt[id];
    if (!node) throw new Error("compiled ancestor missing");
    selected[id] = node;
    for (const value of Object.values(node.inputs))
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        Number.isInteger(value[1]) &&
        prompt[String(value[0])]
      )
        visit(String(value[0]));
  };
  visit(preview![0]);
  const taps: Array<{
    width: string;
    height: string;
    expected: { width: number; height: number };
  }> = [];
  for (const [i, [id, crop]] of crops.entries()) {
    for (const [j, source] of [crop.inputs.image[0], id].entries()) {
      const tap = String(900000 + i * 10 + j * 3);
      selected[tap] = {
        class_type: "GetImageSize",
        inputs: { image: [source, 0] },
      };
      selected[`${tap}1`] = {
        class_type: "PreviewAny",
        inputs: { source: [tap, 0] },
      };
      selected[`${tap}2`] = {
        class_type: "PreviewAny",
        inputs: { source: [tap, 1] },
      };
      taps.push({
        width: `${tap}1`,
        height: `${tap}2`,
        expected:
          j === 1
            ? expectedCrops[i]!
            : i === 0
              ? { width: 640, height: 480 }
              : { width: 480, height: 640 },
      });
    }
  }
  expect(
    Object.values(selected).some((node) =>
      /MiniMaxH3.*ToVideo/.test(node.class_type),
    ),
  ).toBe(false);
  const { history } = await execute(request, selected, 60_000);
  expect(history.outputs[preview![0]]).toBeDefined();
  for (const tap of taps) {
    expect(Number(history.outputs[tap.width]?.text?.[0])).toBe(
      tap.expected.width,
    );
    expect(Number(history.outputs[tap.height]?.text?.[0])).toBe(
      tap.expected.height,
    );
  }
  const temporaryPreviews = crops.filter(([id]) =>
    history.outputs[id]?.images?.some((image: any) => image.type === "temp"),
  ).length;
  expect(temporaryPreviews).toBe(2);
  await testInfo.attach("crop_model_free", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        compiled_regions_equal: true,
        crop_count: 2,
        registry_preview_executed: true,
        decoded_source_sizes_match: true,
        crop_sizes_match: true,
        exif_orientation_match: true,
        temporary_preview_count: temporaryPreviews,
      }),
    ),
  });
});

for (const mode of ["ref2va", "fl2va"] as const) {
  test(`authorized ${mode} crop sample writes exactly one saved video`, async ({
    page,
    context,
    request,
  }, testInfo) => {
    test.setTimeout(45 * 60_000);
    if (process.env.H3_CONTEXT_WEIGHT_SAMPLE !== "1")
      throw new Error("explicit weight sample authorization required");
    const injection = candidateInjectionCount(context);
    await prepare(page, mode);
    await assertCandidateBundleInjection(page, context, injection);
    const selections = await page.evaluate(
      (specs) => {
        const app = (window as any).comfyAPI.app.app;
        const nodes = app.graph._nodes;
        let quantized = 0;
        let vae = 0;
        let resolution = 0;
        const basename = (name: string) =>
          name.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
        for (const node of nodes)
          for (const widget of node.widgets ?? []) {
            const roles = specs.filter(
              (row) => row.widget_name === widget.name,
            );
            const spec =
              roles.find(
                (row) =>
                  typeof widget.value === "string" &&
                  row.accepted_basenames.some(
                    (name) => basename(name) === basename(widget.value),
                  ),
              ) ?? (roles.length === 1 ? roles[0] : undefined);
            if (
              spec &&
              ["UNETLoader", "VAELoader"].includes(spec.loader_type)
            ) {
              const definition = Object.values(
                (window as any).LiteGraph.registered_node_types,
              ).find(
                (entry: any) => entry.nodeData?.name === spec.loader_type,
              ) as any;
              const choices =
                definition?.nodeData?.input?.required?.[spec.widget_name]?.[0];
              const accepted = new Set(
                spec.accepted_basenames.map((value) => value.toLowerCase()),
              );
              const candidates = Array.isArray(choices)
                ? choices.filter(
                    (value: unknown): value is string =>
                      typeof value === "string" &&
                      accepted.has(basename(value)),
                  )
                : [];
              const selected =
                spec.loader_type === "UNETLoader"
                  ? candidates.find((value: string) =>
                      /_(int8_convrot|fp8_scaled)\.safetensors$/i.test(value),
                    )
                  : (candidates.find(
                      (value: string) => value === spec.template_default,
                    ) ?? candidates[0]);
              if (selected) {
                widget.value = selected;
                widget.callback?.(selected);
                if (spec.loader_type === "UNETLoader") quantized++;
                else vae++;
              }
            }
            if (
              widget.name === "megapixels" &&
              widget.options.min <= 0.2 &&
              widget.options.max >= 0.2
            ) {
              widget.value = 0.2;
              widget.callback?.(0.2);
              resolution++;
            }
          }
        app.graph.setDirtyCanvas(true, true);
        return { quantized, vae, resolution };
      },
      officialAssetManifest.slots.filter((spec) =>
        officialAssetManifest.materialization_families[
          mode === "ref2va" ? "reference_to_video" : "image_to_video"
        ].includes(spec.slot),
      ),
    );
    expect(selections.quantized).toBeGreaterThan(0);
    expect(selections.vae).toBeGreaterThan(0);
    const prompt = (await page.evaluate(
      async () =>
        (await (window as any).comfyAPI.app.app.graphToPrompt()).output,
    )) as Prompt;
    assertCropWeightSampleGeometry(
      mode,
      prompt,
      selections.resolution,
      fixture().images[0],
    );
    const crops = Object.entries(prompt).filter(
      ([, node]) => node.class_type === "ImageCropV2",
    );
    expect(crops.map(([, node]) => node.inputs.crop_region)).toEqual(
      expectedCrops,
    );
    expect(
      Object.values(prompt).some(
        (node) =>
          node.class_type === "ResolutionSelector" &&
          node.inputs.megapixels === 0.2,
      ),
    ).toBe(true);
    const { history, id } = await execute(request, prompt, 40 * 60_000);
    const payload = { [id]: history };
    expect(decodeComfyPromptHistory(payload, id).disposition).toBe("succeeded");
    const videos = decodeComfyPromptHistorySavedVideos(payload, id).artifacts;
    expect(videos).toHaveLength(1);
    expect(prompt[videos[0]!.outputNodeId!]?.class_type).toBe("SaveVideo");
    const previewCount = crops.filter(([nodeId]) =>
      history.outputs[nodeId]?.images?.some(
        (image: any) => image.type === "temp",
      ),
    ).length;
    expect(previewCount).toBe(2);
    const artifact = videos[0]!;
    const response = await request.get(`${hostUrl}/view`, {
      params: {
        filename: artifact.locator.filename,
        subfolder: artifact.locator.subfolder,
        type: "output",
      },
    });
    expect(response.ok()).toBe(true);
    const bytes = await response.body();
    expect(bytes.length).toBeGreaterThan(1024);
    expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
    await testInfo.attach("crop_weight_sample", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          mode,
          compiled_regions_equal: true,
          crop_count: 2,
          fixed_ratios: ["1:1", "2:3"],
          quantized_model: true,
          megapixels: 0.2,
          temporary_preview_count: previewCount,
          saved_video_count: videos.length,
          saved_video_readable: true,
          saved_video_bytes: bytes.length,
        }),
      ),
    });
  });
}
