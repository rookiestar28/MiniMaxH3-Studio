import { createHash } from "node:crypto";

import { expect, test } from "../../host/fixture";
import {
  assertCandidateBundleInjection,
  candidateBackendMode,
  candidateBackendRuntime,
  candidateBundle,
  candidateInjectionCount,
  hostUrl,
} from "../../host/candidate";
import {
  beginSettledH3InteractionPhase,
  expectCandidateInteractionNetworkLocal,
  monitorCandidateInitiatorNetwork,
  monitorH3Network,
  waitForH3Registration,
} from "../../host/network";
import {
  MODE_TEMPLATE,
  TASK_MODE_FAMILY,
  spliceContextPipeline,
  type Json,
} from "../../../../src/host/templateMaterialization";
import {
  assertDrivesDimensions,
  assertNamedWidgetValues,
  assertNoIncomingEdges,
  assertNoOutputEdges,
  collectGeometry,
  createDeniedNetworkRecorder,
  projectGeometryStructure,
  resolveGeometryAssets,
  type GeometryAssetReceipt,
} from "./geometryInvariants";

// Row 1 characterizes the base; the committed removal candidate changes only this expectation.
const I2VA_SELECTOR_STATE: "present" | "removed" = "removed";
const TEMPLATE_SHA256 =
  "34ee39544808fd3b0dc8de9df082940d4d41c3771beb80d3988c1ea5531cec0d"; // pragma: allowlist secret
type Edge = [number, number, number, number, number, string];
type Node = {
  id: number;
  type: string;
  inputs?: {
    name: string;
    type: string;
    link?: number | null;
    widget?: unknown;
  }[];
  outputs?: { name: string; type: string; links?: number[] | null }[];
  widgets_values?: unknown[];
};
type Graph = {
  nodes: Node[];
  links: Edge[];
  definitions?: {
    subgraphs?: {
      id: string;
      nodes: Node[];
      inputs: { name: string; linkIds: number[] }[];
      links: {
        id: number;
        origin_id: number;
        origin_slot: number;
        target_id: number;
        target_slot: number;
      }[];
    }[];
  };
};

test.use({ serviceWorkers: "block", acceptDownloads: false });

test("prepares I2VA and FL2VA and reads geometry without execution", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  if (!hostUrl || !candidateBundle || !candidateBackendRuntime)
    throw new Error("exact supplied-host candidate and URL are required");
  if (candidateBackendMode !== "exact")
    throw new Error("exact backend mode required");
  const origin = new URL(hostUrl).origin;
  const network = monitorH3Network(page, origin);
  const candidateNetwork = await monitorCandidateInitiatorNetwork(
    context,
    page,
    origin,
  );
  const deniedNetwork = createDeniedNetworkRecorder(origin);
  let promptRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:api\/)?prompt$/.test(new URL(request.url()).pathname)
    )
      promptRequests += 1;
  });
  page.on("download", (download) => {
    deniedNetwork.record("download", download.url());
    void download.cancel();
  });
  await context.routeWebSocket("**/*", (route) => {
    const url = new URL(route.url());
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    if (url.origin !== origin) {
      deniedNetwork.record("websocket", route.url());
      route.close();
      return;
    }
    route.connectToServer();
  });
  // CRITICAL: install before navigation; fallback keeps the fixture's exact bundle route active.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const forbidden =
      url.origin !== origin ||
      (/\/(?:prompt|queue|download|downloads|provider)(?:\/|$)/i.test(
        url.pathname,
      ) &&
        request.method() !== "GET") ||
      /\/(?:download|downloads|providers?)(?:\/|$)/i.test(url.pathname);
    if (forbidden) {
      deniedNetwork.record("http", request.url(), request.method());
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
  await context.addInitScript(() => {
    // Queue seams may appear after page initialization. The network guard covers that interval.
    (
      window as unknown as { __geometryQueueAttempts: number }
    ).__geometryQueueAttempts = 0;
  });
  const injectionBefore = candidateInjectionCount(context);
  await page.goto(hostUrl, { waitUntil: "domcontentloaded" });
  await waitForH3Registration(page);
  await assertCandidateBundleInjection(page, context, injectionBefore);
  // CRITICAL: startup traffic is host context outside the maintained H3 interaction window.
  // Flip the guard with that window. Resolution removes missing-model candidates, not the scan:
  // A host run measured 8 interaction HEADs; resolving every slot reduced that count to 0.
  await beginSettledH3InteractionPhase(page, network, candidateNetwork);
  deniedNetwork.beginInteractionPhase();
  await page.evaluate(() => {
    const runtime = window as unknown as {
      comfyAPI: {
        api: { api: { queuePrompt: (...args: unknown[]) => unknown } };
      };
      __geometryQueueAttempts: number;
    };
    if (typeof runtime.comfyAPI.api.api.queuePrompt !== "function")
      throw new Error("host queue seam unavailable");
    runtime.comfyAPI.api.api.queuePrompt = () => {
      runtime.__geometryQueueAttempts += 1;
      throw new Error("execution is forbidden in geometry readback");
    };
  });
  const queueCounts = async () =>
    await page.evaluate(async () => {
      const response = await fetch("/queue");
      if (!response.ok) throw new Error("queue readback unavailable");
      const wire = await response.json();
      if (
        !Array.isArray(wire.queue_running) ||
        !Array.isArray(wire.queue_pending)
      )
        throw new Error("queue readback malformed");
      return {
        running: wire.queue_running.length,
        pending: wire.queue_pending.length,
      };
    });
  const queueBefore = await queueCounts();
  if (queueBefore.running !== 0 || queueBefore.pending !== 0)
    throw new Error("geometry readback requires an idle queue");
  const templateText = await page.evaluate(async () => {
    const response = await fetch("/templates/video_minimax_h3_i2v.json");
    if (!response.ok) throw new Error("served template unavailable");
    if (!response.body) throw new Error("served template body unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let total = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1_048_576) {
        await reader.cancel();
        throw new Error("template exceeds read bound");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  });
  const templateSha256 = createHash("sha256")
    .update(templateText)
    .digest("hex");
  if (templateSha256 !== TEMPLATE_SHA256)
    throw new Error("served template identity mismatch");
  const template = JSON.parse(templateText) as Json;
  let queueAfter: { running: number; pending: number } | null = null;
  let queueAttempts: number | null = null;
  const assetResolutions: {
    mode: "i2va" | "fl2va";
    resolution: GeometryAssetReceipt;
  }[] = [];
  const projections = await collectGeometry(
    (["i2va", "fl2va"] as const).map((mode) => async () => {
      const definitions = await page.evaluate(async () => {
        const response = await fetch("/object_info");
        if (!response.ok) throw new Error("host node definitions unavailable");
        return await response.json();
      });
      const resolved = resolveGeometryAssets(
        template,
        TASK_MODE_FAMILY[mode],
        definitions,
      );
      assetResolutions.push({ mode, resolution: resolved.receipt });
      const prepared = spliceContextPipeline(resolved.workflow, {
        taskMode: mode,
        userIntent: "",
        durationSeconds: 5,
        media: {
          firstFrame: {
            type: "LoadImage",
            widgetValues: ["geometry-first.png", "image"],
          },
          ...(mode === "fl2va"
            ? {
                lastFrame: {
                  type: "LoadImage",
                  widgetValues: ["geometry-last.png", "image"],
                },
              }
            : {}),
        },
      });
      const preparedGraph = prepared.workflow as unknown as Graph;
      const anchorType = preparedGraph.nodes.find(
        (n) => n.id === prepared.anchorNodeId,
      )!.type;
      await page.evaluate(async (workflow) => {
        const app = (
          window as unknown as {
            comfyAPI: {
              app: {
                app: {
                  loadGraphData: (graph: unknown) => Promise<unknown>;
                };
              };
            };
          }
        ).comfyAPI.app.app;
        await app.loadGraphData(workflow);
      }, prepared.workflow);
      // Observe stability without replacing foreign callbacks or compiling a synthetic host graph.
      let previous = "";
      let settled = false;
      for (let sample = 0; sample < 40; sample += 1) {
        const current = await page.evaluate(() => {
          const app = (
            window as unknown as {
              comfyAPI: {
                app: {
                  app: {
                    graph: { serialize: () => Graph };
                  };
                };
              };
            }
          ).comfyAPI.app.app;
          const graph = app.graph.serialize();
          return JSON.stringify({
            nodes: graph.nodes.map((n) => [n.id, n.type]),
            links: graph.links,
          });
        });
        if (current === previous) {
          settled = true;
          break;
        }
        previous = current;
        await page.waitForTimeout(500);
      }
      const projection = await page.evaluate(
        async ({ anchorType }) => {
          type Compiled = {
            class_type: string;
            inputs: Record<string, unknown>;
          };
          const app = (
            window as unknown as {
              comfyAPI: {
                app: {
                  app: {
                    graph: {
                      serialize: () => Graph;
                      getNodeById: (id: number) => {
                        widgets?: { name: string; value: unknown }[];
                      } | null;
                    };
                    graphToPrompt: () => Promise<{
                      output: Record<string, Compiled>;
                    }>;
                  };
                };
              };
            }
          ).comfyAPI.app.app;
          const graph = app.graph.serialize();
          const unique = (type: string) => {
            const matches = graph.nodes.filter((n) => n.type === type);
            if (matches.length !== 1)
              throw new Error(`geometry identity not unique: ${type}`);
            return matches[0];
          };
          const anchor = unique(anchorType);
          const scale = unique("ImageScaleToTotalPixels");
          const size = unique("GetImageSize");
          const selectors = graph.nodes.filter(
            (n) => n.type === "ResolutionSelector",
          );
          if (selectors.length > 1)
            throw new Error("selector identity ambiguous");
          const selector = selectors[0];
          const structure = (node: Node) => {
            const names =
              node.type === "ResolutionSelector"
                ? ["aspect_ratio", "megapixels", "multiple"]
                : node.type === "ImageScaleToTotalPixels"
                  ? ["upscale_method", "megapixels", "resolution_steps"]
                  : [];
            const live = app.graph.getNodeById(node.id);
            if (!live) throw new Error("live geometry node missing");
            return {
              id: node.id,
              type: node.type,
              inputs: (node.inputs ?? []).map((input) => ({
                name: input.name,
                type: input.type,
                widget: input.widget != null,
                link: input.link ?? null,
              })),
              outputs: (node.outputs ?? []).map((output) => ({
                name: output.name,
                type: output.type,
                links: output.links ?? null,
              })),
              // Keep geometry-only values. Preview/foreign widgets may contain arbitrary text.
              widgets: (live.widgets ?? [])
                .filter((widget) => names.includes(widget.name))
                .map((widget) => {
                  const value = widget.value;
                  if (
                    value !== null &&
                    typeof value !== "string" &&
                    typeof value !== "number" &&
                    typeof value !== "boolean"
                  )
                    throw new Error("geometry widget is not a scalar");
                  return { name: widget.name, value };
                }),
            };
          };
          const source = (node: Node, name: string) => {
            const input = node.inputs?.find((i) => i.name === name);
            if (input?.link == null) return null;
            const edge = graph.links.find((e) => e[0] === input.link);
            if (!edge || edge[3] !== node.id)
              throw new Error("geometry edge join failed");
            const upstream = graph.nodes.find((n) => n.id === edge[1]);
            if (!upstream) throw new Error("geometry source missing");
            return {
              id: String(upstream.id),
              type: upstream.type,
              slot: edge[2],
              edge,
            };
          };
          const definition = graph.definitions?.subgraphs?.find(
            (d) => d.id === anchor.type,
          );
          const natives =
            definition?.nodes.filter(
              (n) => n.type === "MiniMaxH3ImageToVideo",
            ) ?? [];
          if (!definition || natives.length !== 1)
            throw new Error("native geometry join failed");
          const native = natives[0];
          const promoted = ["first_frame", "last_frame", "width", "height"].map(
            (name) => {
              const port = definition.inputs.find((p) => p.name === name);
              const input = native.inputs?.find((p) => p.name === name);
              const edge = definition.links.find((e) => e.id === input?.link);
              if (
                !port ||
                !edge ||
                !port.linkIds.includes(edge.id) ||
                edge.origin_id !== -10 ||
                edge.target_id !== native.id
              )
                throw new Error(`native promoted input join failed: ${name}`);
              return {
                name,
                source_slot: edge.origin_slot,
                target_slot: edge.target_slot,
              };
            },
          );
          const output = (await app.graphToPrompt()).output;
          const compiledNatives = Object.entries(output).filter(
            ([, n]) => n.class_type === native.type,
          );
          if (compiledNatives.length !== 1)
            throw new Error("compiled native identity ambiguous");
          const [nativeId, compiledNative] = compiledNatives[0];
          if (nativeId !== `${anchor.id}:${native.id}`)
            throw new Error(
              "compiled native does not join serialized anchor and definition",
            );
          const compiledSource = (value: unknown) => {
            if (value === undefined) return null;
            if (
              !Array.isArray(value) ||
              value.length !== 2 ||
              !Number.isInteger(value[1])
            )
              throw new Error("compiled geometry input is not a link");
            const id = String(value[0]);
            if (!output[id])
              throw new Error("compiled geometry source missing");
            return {
              id,
              type: output[id].class_type,
              slot: value[1] as number,
            };
          };
          const descendants = new Set([scale.id]);
          for (let pass = 0; pass < graph.nodes.length; pass += 1)
            for (const edge of graph.links)
              if (descendants.has(edge[1])) descendants.add(edge[3]);
          const geometryIds = new Set([
            anchor.id,
            scale.id,
            size.id,
            ...(selector ? [selector.id] : []),
          ]);
          return {
            anchor: { id: anchor.id, type: anchor.type },
            native: { id: native.id, compiledId: nativeId },
            promoted,
            selector: selector ? structure(selector) : null,
            scale: {
              ...structure(scale),
              image: source(scale, "image"),
            },
            size: {
              ...structure(size),
              image: source(size, "image"),
            },
            dimensionTargets: ["width", "height"].map((name) => ({
              name,
              slot: (anchor.inputs ?? []).findIndex(
                (input) => input.name === name,
              ),
            })),
            dimensions: [source(anchor, "width"), source(anchor, "height")],
            media: [
              source(anchor, "first_frame"),
              source(anchor, "last_frame"),
            ],
            geometryEdges: graph.links.filter(
              (e) => geometryIds.has(e[1]) || geometryIds.has(e[3]),
            ),
            scaleReachesAnchor: descendants.has(anchor.id),
            compiledDimensions: [
              compiledSource(compiledNative.inputs.width),
              compiledSource(compiledNative.inputs.height),
            ],
            compiledMedia: [
              compiledSource(compiledNative.inputs.first_frame),
              compiledSource(compiledNative.inputs.last_frame),
            ],
            compiledScaleImage: output[String(scale.id)]
              ? compiledSource(output[String(scale.id)].inputs.image)
              : null,
            compiledScaleMegapixels:
              output[String(scale.id)]?.inputs.megapixels ?? null,
            compiledSizeImage: output[String(size.id)]
              ? compiledSource(output[String(size.id)].inputs.image)
              : null,
          };
        },
        { anchorType },
      );
      return {
        mode,
        preparedAnchor: prepared.anchorNodeId,
        nestedAnchor: prepared.nestedAnchor,
        settled,
        sourceJoin: {
          anchor: 105,
          selector: 115,
          scale: 119,
          size: 120,
          native: 104,
        },
        ...projection,
        selector: projection.selector
          ? projectGeometryStructure(projection.selector)
          : null,
        scale: {
          ...projection.scale,
          ...projectGeometryStructure(projection.scale),
        },
        size: {
          ...projection.size,
          ...projectGeometryStructure(projection.size),
        },
      };
    }),
    async (observations) => {
      try {
        queueAfter = await queueCounts();
        queueAttempts = await page.evaluate(
          () =>
            (window as unknown as { __geometryQueueAttempts: number })
              .__geometryQueueAttempts,
        );
      } catch {
        // Null readbacks stay visible and fail the exact final assertions after retention.
      }
      await testInfo.attach("geometry_readback", {
        body: Buffer.from(
          JSON.stringify({
            templateSha256,
            selectorState: I2VA_SELECTOR_STATE,
            queueBefore,
            queueAfter,
            queueAttempts,
            promptRequests,
            deniedNetwork: deniedNetwork.snapshot(),
            network: network.snapshot(),
            candidateNetwork: candidateNetwork?.snapshot() ?? null,
            assetResolutions,
            ...observations,
          }),
        ),
        contentType: "application/json",
      });
    },
  );
  // CRITICAL: retain both modes before assertions; a representation mismatch must not hide
  // the geometry that explains the failing case, as the old input-array check did.
  expect(candidateBackendMode).toBe("exact");
  expect(queueBefore).toEqual({ running: 0, pending: 0 });
  expect(MODE_TEMPLATE.i2va).toBe("video_minimax_h3_i2v");
  expect(MODE_TEMPLATE.fl2va).toBe(MODE_TEMPLATE.i2va);
  expect(templateSha256).toBe(TEMPLATE_SHA256);
  for (const projection of projections) {
    const { mode } = projection;
    expect(projection.preparedAnchor).toBe(105);
    expect(projection.nestedAnchor).toBe(true);
    expect(projection.settled).toBe(true);
    expect(projection.anchor.id).toBe(105);
    expect(projection.native.id).toBe(104);
    expect(projection.scale.id).toBe(119);
    expect(projection.size.id).toBe(120);
    if (projection.selector) expect(projection.selector.id).toBe(115);
    const dimensionId =
      mode === "i2va" ? projection.size.id : projection.selector!.id;
    expect(projection.dimensions.map((s) => [s?.id, s?.slot])).toEqual([
      [String(dimensionId), 0],
      [String(dimensionId), 1],
    ]);
    expect(projection.compiledDimensions).toEqual(
      projection.dimensions.map(
        (s) => s && { id: s.id, type: s.type, slot: s.slot },
      ),
    );
    expect(projection.compiledMedia).toEqual(
      projection.media.map(
        (s) => s && { id: s.id, type: s.type, slot: s.slot },
      ),
    );
    expect(projection.media[0]?.type).toBe("LoadImage");
    expect(projection.size.image?.id).toBe(String(projection.scale.id));
    expect(
      projection.promoted.map((p) => [p.name, p.source_slot, p.target_slot]),
    ).toEqual([
      ["first_frame", 0, 2],
      ["last_frame", 1, 3],
      ["width", 3, 5],
      ["height", 4, 6],
    ]);
    if (mode === "i2va") {
      expect(projection.selector === null ? "removed" : "present").toBe(
        I2VA_SELECTOR_STATE,
      );
      if (projection.selector) {
        assertNoIncomingEdges(projection.selector, projection.geometryEdges);
        assertNoOutputEdges(projection.selector, projection.geometryEdges);
      }
      assertNamedWidgetValues(projection.scale, {
        upscale_method: "nearest-exact",
        megapixels: 0.8,
        resolution_steps: 32,
      });
      expect(projection.scale.image?.id).toBe(projection.media[0]?.id);
      expect(projection.compiledScaleMegapixels).toBe(0.8);
      expect(projection.compiledScaleImage?.id).toBe(projection.media[0]?.id);
      expect(projection.compiledSizeImage?.id).toBe(
        String(projection.scale.id),
      );
      expect(projection.scaleReachesAnchor).toBe(true);
      expect(projection.media[1]).toBeNull();
    } else {
      if (!projection.selector) throw new Error("FL2VA selector missing");
      assertNoIncomingEdges(projection.selector, projection.geometryEdges);
      assertNamedWidgetValues(projection.selector, {
        aspect_ratio: "1:1 (Square)",
        megapixels: 0.4,
        multiple: 32,
      });
      assertDrivesDimensions(
        projection.selector,
        projection.anchor.id,
        projection.dimensionTargets,
        projection.geometryEdges,
      );
      assertNamedWidgetValues(projection.scale, {
        upscale_method: "nearest-exact",
        megapixels: 0.9,
        resolution_steps: 32,
      });
      expect(projection.scale.image).toBeNull();
      assertNoOutputEdges(projection.size, projection.geometryEdges);
      expect(projection.scaleReachesAnchor).toBe(false);
      expect(projection.media[1]?.type).toBe("LoadImage");
      expect(projection.media[1]?.id).not.toBe(projection.media[0]?.id);
    }
  }
  expect(queueAfter).toEqual({ running: 0, pending: 0 });
  expect(queueAttempts).toBe(0);
  expect(promptRequests).toBe(0);
  expect(assetResolutions.map(({ mode }) => mode)).toEqual(["i2va", "fl2va"]);
  for (const { resolution } of assetResolutions)
    expect(resolution.unresolvedSlots).toEqual([]);
  expect(network.snapshot().interactionRemoteCount).toBe(0);
  expect(network.snapshot().interactionProviderCount).toBe(0);
  expectCandidateInteractionNetworkLocal(candidateNetwork);
  expect(deniedNetwork.snapshot().interactionCount).toBe(0);
});
