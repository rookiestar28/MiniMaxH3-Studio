import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  decodeProductionWorkbenchProjection,
  encodeProductionAction,
  type ProductionWorkbenchProjection,
} from "../../../../src/contracts/productionWorkbenchCodec";
import { expect, test } from "../../host/fixture";
import {
  assertCandidateBundleInjection,
  candidateBackendMode,
  candidateBundle,
  candidateInjectionCount,
  hostUrl,
  openH3AppModeTab,
  repositoryRoot,
  supportedHostQueueCounts,
  waitForH3Registration,
} from "../../host/environment";
import {
  bootstrapFrameContext,
  copyNativeFrameOutput,
  frameSequenceMediaRoot,
  frameSequenceRows,
  nativeFrameCanvasState,
  nativeFrameSelection,
  nativeFrameParityFields,
  planFrameSequence,
  prepareNativeFrameCanvas,
  waitForNativeFrameStartup,
  type NativeFramePrompt,
} from "../../host/frameModeSequence";
import { normalizeM2508HostApiPath } from "../../host/m25_08RequestClassification";
import { createNativeCompileDiagnostics } from "../../host/nativeCompileDiagnostics";
import {
  createOwnerCapture,
  ownedPath,
  post,
} from "../../host/productionRuntimeRow";
import { projectOwnedPath } from "../../host/projectOwnedPath";
import {
  productionAssemblyObservation,
  refreshProductionAssembly,
} from "../../helpers/productionAssembly";
import {
  decodeProductionPlanningResponse,
  PRODUCTION_AUTOMATIC_PLAN_SCHEMA,
} from "../../../../src/contracts/productionPlanningCodec";
import {
  decodeManagedSequenceMutationResult,
  MANAGED_SEQUENCE_ROUTE,
} from "../../../../src/host/managedSequenceClient";
import {
  createSequenceSubmissionAttribution,
  parseSequenceDiagnosticAttributes,
  sequenceDiagnosticAttributes,
} from "../../host/frameSequenceDiagnostics";

const ROUTE = "/h3-context/v1/production/action";
let representativeClosing: ReturnType<typeof nativeFrameSelection> | undefined;

for (const row of frameSequenceRows) {
  test(`frame-mode sequence ${row.id} generates and assembles on the supplied host`, async ({
    page,
    context,
  }) => {
    test.skip(
      process.env.H3_CONTEXT_FRAME_SEQUENCE_ROW !== row.id,
      "one explicitly authorized supplied-host row is required",
    );
    test.setTimeout(90 * 60_000);
    if (!hostUrl || !candidateBundle || candidateBackendMode !== "exact")
      throw new Error(
        "the exact installed candidate and supplied host are required",
      );
    const evidenceValue = process.env.H3_CONTEXT_FRAME_SEQUENCE_EVIDENCE;
    const apparatusValue = process.env.H3_CONTEXT_FRAME_SEQUENCE_APPARATUS;
    if (!evidenceValue || !apparatusValue)
      throw new Error("owned evidence and passive observer paths are required");
    const phase = process.env.H3_CONTEXT_FRAME_SEQUENCE_PHASE;
    if (phase !== "prepare" && phase !== "generate")
      throw new Error("explicit prepare or generate phase is required");
    const evidence = projectOwnedPath(repositoryRoot, evidenceValue);
    const mediaRoot = ownedPath(frameSequenceMediaRoot(evidenceValue));
    await mkdir(evidence, { recursive: true });
    const capture = await createOwnerCapture(
      projectOwnedPath(repositoryRoot, apparatusValue),
      evidence,
    );
    const observation: Record<string, unknown> = {
      schema: "h3.context.frame_sequence_host_observation.v1",
      row: row.id,
    };
    let projection: ProductionWorkbenchProjection | undefined;
    let observed = false;
    let primaryFailed = false;
    const routeFailures: number[] = [];
    const queueSummaries: Array<Record<string, unknown>> = [];
    const queuedPromptIds: string[] = [];
    const attribution = createSequenceSubmissionAttribution();
    page.on("request", (request) => {
      if (
        request.method() !== "POST" ||
        !new URL(request.url()).pathname.endsWith("/prompt")
      )
        return;
      const prompt = request.postDataJSON()?.prompt as
        | Record<
            string,
            { class_type: string; inputs: Record<string, unknown> }
          >
        | undefined;
      if (prompt === undefined) return;
      const nodes = Object.values(prompt);
      const anchors = nodes.filter(
        (node) => node.class_type === "MiniMaxH3ImageToVideo",
      );
      if (anchors.length === 0) return;
      const selection = nativeFrameSelection(prompt);
      if (row.id === "fl2va-fixed-26") representativeClosing = selection;
      const guides = nodes.filter(
        (node) => node.class_type === "MiniMaxH3AddGuide",
      );
      const models = nodes.filter((node) =>
        ["UNETLoader", "CLIPLoader", "VAELoader"].includes(node.class_type),
      );
      queueSummaries.push({
        anchorCount: anchors.length,
        firstFrame: Array.isArray(anchors[0]!.inputs.first_frame),
        lastFrame: Array.isArray(anchors[0]!.inputs.last_frame),
        guideIndices: guides.map((node) => node.inputs.frame_idx),
        modelSelectionDigest: createHash("sha256")
          .update(
            JSON.stringify(
              models.map((node) => [node.class_type, node.inputs]).sort(),
            ),
          )
          .digest("hex"),
        referenceAnchorCount: nodes.filter(
          (node) => node.class_type === "MiniMaxH3ReferenceToVideo",
        ).length,
        parityDigest: createHash("sha256")
          .update(JSON.stringify(selection))
          .digest("hex"),
      });
    });
    const productionResponses = new Set<Promise<void>>();
    page.on("response", (response) => {
      const path = normalizeM2508HostApiPath(new URL(response.url()).pathname);
      if (
        response.request().method() === "POST" &&
        (path === MANAGED_SEQUENCE_ROUTE ||
          path === "/h3-context/v1/production/planning/action" ||
          path.endsWith("/prompt"))
      ) {
        const diagnosticTask = (async () => {
          if (response.status() !== 200) return;
          if (path.endsWith("/prompt")) {
            const prompt = (await response.json()).prompt_id;
            if (typeof prompt === "string" && prompt.length > 0)
              attribution.prompt(prompt);
            else attribution.unavailable();
          } else if (path === MANAGED_SEQUENCE_ROUTE) {
            const request = response.request().postDataJSON();
            if (
              request?.action !== "authorize_sequence" &&
              request?.action !== "record_submission"
            )
              return;
            const result = decodeManagedSequenceMutationResult(
              await response.json(),
            );
            const payload = request.payload;
            if (
              request.action === "authorize_sequence" &&
              typeof payload?.expected_plan_fingerprint === "string"
            )
              attribution.authorize(
                result.parentSequenceId,
                payload.expected_plan_fingerprint,
              );
            else if (
              request.action === "record_submission" &&
              payload?.parent_sequence_id === result.parentSequenceId &&
              typeof payload.segment_id === "string" &&
              typeof payload.queue_prompt_id === "string"
            )
              attribution.submission(
                result.parentSequenceId,
                payload.segment_id,
                payload.queue_prompt_id,
              );
            else attribution.unavailable();
          } else {
            const request = response.request().postDataJSON();
            if (
              request?.action !== "import_plan" &&
              request?.action !== "read_plan"
            )
              return;
            const plan = decodeProductionPlanningResponse(
              await response.json(),
            );
            if (plan.schema === PRODUCTION_AUTOMATIC_PLAN_SCHEMA)
              attribution.plan(plan.plan_fingerprint, plan.segment_ids);
            else attribution.unavailable();
          }
        })().catch(() => attribution.unavailable());
        productionResponses.add(diagnosticTask);
        void diagnosticTask.finally(() =>
          productionResponses.delete(diagnosticTask),
        );
      }
      if (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/prompt")
      ) {
        const nodes = Object.values(
          response.request().postDataJSON()?.prompt ?? {},
        ) as Array<{ class_type?: string }>;
        if (nodes.some((node) => node.class_type === "MiniMaxH3ImageToVideo")) {
          const task = (async () => {
            if (response.status() !== 200) {
              routeFailures.push(response.status());
              return;
            }
            queuedPromptIds.push(String((await response.json()).prompt_id));
          })().catch(() => {
            routeFailures.push(-1);
          });
          productionResponses.add(task);
          void task.finally(() => productionResponses.delete(task));
        }
        return;
      }
      if (normalizeM2508HostApiPath(new URL(response.url()).pathname) !== ROUTE)
        return;
      const task = (async () => {
        const action = response.request().postDataJSON()?.action;
        const expected =
          action === "create_workspace_from_context"
            ? 201
            : action === "release_workspace"
              ? 204
              : 200;
        if (response.status() !== expected) {
          routeFailures.push(response.status());
          return;
        }
        if (action !== "release_workspace")
          projection = decodeProductionWorkbenchProjection(
            await response.json(),
          );
      })().catch(() => {
        routeFailures.push(-1);
      });
      productionResponses.add(task);
      void task.finally(() => productionResponses.delete(task));
    });
    expect(await supportedHostQueueCounts(page)).toEqual({
      running: 0,
      pending: 0,
    });
    const injectionCount = candidateInjectionCount(context);
    await page.goto(hostUrl, { waitUntil: "domcontentloaded" });
    await waitForH3Registration(page);
    await assertCandidateBundleInjection(page, context, injectionCount);
    const shell = await openH3AppModeTab(
      page,
      `h3-context-frame-sequence-${row.id}`,
    );
    try {
      attribution.bootstrap(await bootstrapFrameContext(page, row));
      await shell.locator('[data-page-id="production"]').click();
      await expect
        .poll(() => projection !== undefined, { timeout: 30_000 })
        .toBe(true);
      await planFrameSequence(page, row);
      // IMPORTANT: planning import keeps Production selected; the launcher mounts only in Clip editor.
      await shell.locator('[data-h3-director-function="clip_editor"]').click();
      await shell.locator('[data-h3-nle-entry="open"]').click();
      await page.locator("#h3-nle-tab-sequence").click();
      const sequence = page.locator('[data-h3-nle-region="sequence"]');
      await sequence
        .locator('[data-h3-nle-control="readiness.request"]')
        .click();
      await expect(
        sequence.locator('[data-h3-nle-status="readiness"]'),
      ).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
      await sequence
        .locator('[data-h3-nle-control="production.refresh"]')
        .click();
      await expect
        .poll(() => projection?.segments.map((segment) => segment.taskMode))
        .toEqual([...row.modes]);
      expect(
        projection!.segments.map(
          (segment) => segment.duration.requestedMilliseconds / 1000,
        ),
      ).toEqual([...row.durations]);
      observation.phase = phase;
      observation.preparedDurations = [...row.durations];
      observation.preparedModes = [...row.modes];
      if (phase === "prepare") {
        expect(queueSummaries).toEqual([]);
        observation.status = "prepared_without_generation";
        return;
      }
      // IMPORTANT: the real UI captures bindings and updates its accepted owned-graph reference.
      // A second test runner or a synthetic executed event would bypass that lifecycle proof.
      await sequence.locator('[data-h3-nle-control="sequence.start"]').click();
      await expect
        .poll(
          async () => {
            const failure = sequence.locator(
              '[data-h3-nle-status="sequence-failure"]',
            );
            const failed =
              (await failure.count()) === 0
                ? null
                : await failure.getAttribute("data-code");
            if (failed !== null)
              throw new Error(`managed sequence refused: ${failed}`);
            return sequence
              .locator('[data-h3-nle-status="sequence"]')
              .getAttribute("data-state");
          },
          { timeout: 75 * 60_000, intervals: [1000] },
        )
        .toBe("finished");
      await expect
        .poll(() => supportedHostQueueCounts(page))
        .toEqual({ running: 0, pending: 0 });
      await sequence
        .locator('[data-h3-nle-control="production.refresh"]')
        .click();
      await expect
        .poll(() =>
          projection?.segments.every(
            (segment) => segment.artifactState === "complete",
          ),
        )
        .toBe(true);
      expect(projection!.segments.map((segment) => segment.taskMode)).toEqual([
        ...row.modes,
      ]);
      expect(queueSummaries).toHaveLength(row.durations.length);
      expect(
        new Set(queueSummaries.map((entry) => entry.modelSelectionDigest)).size,
      ).toBe(1);
      for (const [index, summary] of queueSummaries.entries()) {
        expect(summary.anchorCount).toBe(1);
        expect(summary.referenceAnchorCount).toBe(0);
        expect(summary.firstFrame).toBe(row.modes[index] === "i2va");
        expect(summary.lastFrame).toBe(false);
        expect(summary.guideIndices).toEqual(
          row.modes[index] === "l2va" ? [row.durations[index]! * 24 - 1] : [],
        );
      }
      observation.queuedNativeChildren = queueSummaries;
      expect(
        new Set(
          projection!.segments.map((segment) =>
            JSON.stringify([
              segment.deliveredGeometry?.width,
              segment.deliveredGeometry?.height,
            ]),
          ),
        ).size,
      ).toBe(1);
      expect(
        projection!.segments.map(
          (segment) => segment.deliveredGeometry?.frameCount,
        ),
      ).toEqual(
        row.durations.map(
          (seconds) => Math.ceil((seconds * 24 - 5) / 17) * 17 + 5,
        ),
      );
      observation.children = projection!.segments.map((segment) => ({
        ordinal: segment.ordinal,
        mode: segment.taskMode,
        requestedMilliseconds: segment.duration.requestedMilliseconds,
        frameCount: segment.deliveredGeometry?.frameCount,
        width: segment.deliveredGeometry?.width,
        height: segment.deliveredGeometry?.height,
        artifactState: segment.artifactState,
      }));
      // IMPORTANT: generation publication replaces the registry entry; observing earlier
      // binds the old identity and misses the actual assembly job and its failure chain.
      await capture("observe", projection);
      observed = true;
      await sequence
        .locator('[data-h3-nle-control="assembly.assemble"]')
        .click();
      await refreshProductionAssembly(sequence, 10 * 60_000);
      await expect.poll(() => projection?.assembly.state).toBe("succeeded");
      const captured = await capture("capture", projection);
      const payload = captured.capture as Record<string, any>;
      const crops = payload.outerPlan.derived_input_receipts as Array<
        Record<string, any>
      >;
      expect(crops).toHaveLength(row.durations.length);
      expect(crops.map((entry) => entry.video_crop_span)).toEqual(
        row.durations.map((seconds) => [0, seconds * 24]),
      );
      expect(
        crops.map((entry) => entry.original_artifact_receipt_fingerprint),
      ).toEqual(
        payload.originalArtifactReceipts.map(
          (entry: Record<string, any>) => entry.receipt_fingerprint,
        ),
      );
      expect(payload.assemblyReceipt.output_total_frames).toBe(row.target * 24);
      observation.assemblyCropSpans = crops.map(
        (entry) => entry.video_crop_span,
      );
      await Promise.all(productionResponses);
      expect(queuedPromptIds).toHaveLength(row.durations.length);
      await mkdir(mediaRoot, {
        recursive: true,
      });
      const mediaDirectory = resolve(mediaRoot, row.id);
      await mkdir(mediaDirectory, { recursive: false });
      const media = [];
      for (const [index, promptId] of queuedPromptIds.entries()) {
        const copied = await copyNativeFrameOutput(
          page,
          promptId,
          mediaDirectory,
          `child-${index + 1}.mp4`,
          payload.originalArtifactReceipts[index].output_fingerprint,
        );
        media.push({ ordinal: index + 1, ...copied });
      }
      observation.originalChildCopies = media;
      observation.ownerCaptureStatus = captured.status;
      observation.receiptFingerprint = projection!.assembly.receiptFingerprint;
      observation.childReceiptCount =
        projection!.assembly.artifactReceiptFingerprints.length;
      expect(observation.childReceiptCount).toBe(row.durations.length);
      observation.workspaceDigest = createHash("sha256")
        .update(projection!.workspaceId)
        .digest("hex");
      await Promise.all(productionResponses);
      expect(routeFailures).toEqual([]);
      observation.status = "generated_and_assembled";
    } catch (error) {
      primaryFailed = true;
      observation.status = "failed";
      observation.failureType = error instanceof Error ? error.name : "unknown";
      throw error;
    } finally {
      let diagnosticSnapshot: ReturnType<
        typeof parseSequenceDiagnosticAttributes
      > = null;
      try {
        const panel = page.locator("[data-h3-nle-sequence-ui]");
        if ((await panel.count()) === 1) {
          const values = Object.fromEntries(
            await Promise.all(
              sequenceDiagnosticAttributes.map(
                async (key) =>
                  [
                    key,
                    await panel.getAttribute(`data-h3-nle-${key}`),
                  ] as const,
              ),
            ),
          );
          diagnosticSnapshot = parseSequenceDiagnosticAttributes(values);
        }
      } catch {
        attribution.unavailable();
      }
      const cleanupErrors: string[] = [];
      observation.routeFailures = routeFailures;
      try {
        observation.queue = await supportedHostQueueCounts(page);
      } catch {
        cleanupErrors.push("queue_observation_failed");
      }
      // Restore the passive wrappers even if a later workspace read/release refuses.
      if (observed && process.env.H3_CONTEXT_FRAME_KEEP_OBSERVER !== "1") {
        try {
          await capture("stop");
          observation.observerStopped = true;
        } catch {
          cleanupErrors.push("observer_stop_failed");
        }
      }
      if (observed && process.env.H3_CONTEXT_FRAME_KEEP_OBSERVER === "1")
        observation.observerStopDisposition = "owned_lifecycle_after_baseline";
      // Never clear a shared queue/history, interrupt an unrelated prompt or release active work.
      if (
        projection &&
        JSON.stringify(observation.queue) ===
          JSON.stringify({ running: 0, pending: 0 })
      ) {
        try {
          const read = await post(
            page,
            ROUTE,
            encodeProductionAction("frame.cleanup.read", "read_projection", {
              workspaceHandle: projection.workspaceHandle,
            }),
          );
          expect(read.status).toBe(200);
          const released = await post(
            page,
            ROUTE,
            encodeProductionAction(
              "frame.cleanup.release",
              "release_workspace",
              {
                projection: decodeProductionWorkbenchProjection(read.body),
              },
            ),
          );
          observation.cleanup = { read: read.status, release: released.status };
          expect(released).toEqual({ status: 204, body: null });
        } catch {
          cleanupErrors.push("workspace_release_failed");
        }
      }
      await Promise.all(productionResponses);
      observation.assemblyDiagnostic = productionAssemblyObservation(
        projection?.assembly,
      );
      const diagnosticReport = attribution.report(diagnosticSnapshot);
      observation.sequenceDiagnostic = diagnosticReport;
      observation.disposition =
        diagnosticReport.disposition === "QUESTION"
          ? "QUESTION"
          : primaryFailed
            ? "FAIL"
            : "OBSERVED";
      observation.cleanupErrors = cleanupErrors;
      await writeFile(
        resolve(evidence, "frame-sequence-observation.json"),
        JSON.stringify(observation, null, 2),
        { flag: "wx" },
      );
      if (!primaryFailed) {
        expect(routeFailures).toEqual([]);
        expect(cleanupErrors).toEqual([]);
      }
    }
  });
}

test("native single-clip L2VA S8 baseline follows the representative on the supplied host", async ({
  page,
  context,
}) => {
  if (
    process.env.H3_CONTEXT_FRAME_SEQUENCE_ROW !== "fl2va-fixed-26" ||
    process.env.H3_CONTEXT_FRAME_SEQUENCE_PHASE !== "generate"
  )
    throw new Error(
      "the labelled baseline requires the representative generation selection",
    );
  test.setTimeout(45 * 60_000);
  if (
    !hostUrl ||
    !candidateBundle ||
    candidateBackendMode !== "exact" ||
    !representativeClosing
  )
    throw new Error(
      "the exact successful representative must precede the baseline in this worker",
    );
  const last = process.env.H3_CONTEXT_FRAME_LAST_INPUT;
  const evidenceValue = process.env.H3_CONTEXT_FRAME_SEQUENCE_EVIDENCE;
  if (!last || !evidenceValue)
    throw new Error("scoped last frame and evidence are required");
  const evidence = projectOwnedPath(repositoryRoot, evidenceValue);
  const mediaRoot = ownedPath(frameSequenceMediaRoot(evidenceValue));
  const expectedDigest = createHash("sha256")
    .update(JSON.stringify(representativeClosing))
    .digest("hex");
  const observation: Record<string, unknown> = {
    schema: "h3.context.frame_baseline_observation.v1",
    seconds: 8,
    expectedNativeFrames: 192,
    parityDigest: expectedDigest,
  };
  expect(representativeClosing.seeds.length).toBeGreaterThan(0);
  const injectionCount = candidateInjectionCount(context);
  await page.goto(hostUrl, { waitUntil: "domcontentloaded" });
  await waitForH3Registration(page);
  await assertCandidateBundleInjection(page, context, injectionCount);
  await waitForNativeFrameStartup(page);
  expect(await supportedHostQueueCounts(page)).toEqual({
    running: 0,
    pending: 0,
  });
  // This new page owns a fresh source-only canvas. All generation goes through public sidebar controls.
  await page.evaluate((last) => {
    const runtime = window as unknown as {
      comfyAPI: { app: { app: any } };
      LiteGraph: { createNode(type: string): any };
    };
    const app = runtime.comfyAPI.app.app;
    app.graph.clear();
    const source = runtime.LiteGraph.createNode("LoadImage");
    if (!source) throw new Error("native source control unavailable");
    source.id = 11;
    app.graph.add(source);
    const widget = source.widgets.find(
      (entry: { name?: string }) => entry.name === "image",
    );
    if (!widget) throw new Error("native image widget unavailable");
    widget.value = last;
    app.graph.change();
  }, last);
  const shell = await openH3AppModeTab(
    page,
    "h3-context-frame-native-baseline",
  );
  let promptId: string | undefined;
  const responseReads: Promise<void>[] = [];
  let responseFailure = false;
  let queued = 0;
  page.on("response", (response) => {
    if (
      response.request().method() !== "POST" ||
      !new URL(response.url()).pathname.endsWith("/prompt")
    )
      return;
    const prompt = response.request().postDataJSON()?.prompt as
      NativeFramePrompt | undefined;
    if (
      !prompt ||
      !Object.values(prompt).some(
        (node) => node.class_type === "MiniMaxH3ImageToVideo",
      )
    )
      return;
    queued += 1;
    const actual = nativeFrameSelection(prompt);
    const digest = createHash("sha256")
      .update(JSON.stringify(actual))
      .digest("hex");
    observation.queuedParityDigest = digest;
    responseReads.push(
      (async () => {
        expect(response.status()).toBe(200);
        expect(digest).toBe(expectedDigest);
        const anchors = Object.values(prompt).filter(
          (node) => node.class_type === "MiniMaxH3ImageToVideo",
        );
        expect(Array.isArray(anchors[0]!.inputs.first_frame)).toBe(false);
        expect(Array.isArray(anchors[0]!.inputs.last_frame)).toBe(true);
        expect(
          Object.values(prompt).filter(
            (node) => node.class_type === "MiniMaxH3AddGuide",
          ),
        ).toHaveLength(0);
        promptId = String((await response.json()).prompt_id);
      })().catch(() => {
        responseFailure = true;
      }),
    );
  });
  try {
    await shell
      .locator('[data-h3-focus-key="app-task-mode"]')
      .selectOption("l2va");
    const source = shell.locator('[data-h3-focus-key="app-last-frame"]');
    await expect(source.locator('option[value="11"]')).toHaveCount(1);
    await source.selectOption("11");
    await shell
      .locator('[data-h3-focus-key="app-intent"]')
      .fill(representativeClosing.intent);
    await shell.locator('[data-h3-focus-key="app-duration-seconds"]').fill("8");
    const submit = shell.locator('[data-h3-focus-key="app-submit"]');
    await expect(submit).toBeEnabled({ timeout: 60_000 });
    expect(
      await page.evaluate((expectedImage) => {
        const runtime = window as unknown as {
          comfyAPI: { app: { app: any } };
        };
        const source = runtime.comfyAPI.app.app.graph.getNodeById(11);
        return (
          source?.type === "LoadImage" &&
          source.widgets?.find(
            (widget: { name?: string }) => widget.name === "image",
          )?.value === expectedImage
        );
      }, last),
    ).toBe(true);
    const compiler = await page.evaluateHandle(
      () =>
        (
          window as unknown as {
            comfyAPI: {
              app: { app: { graphToPrompt?: (...args: unknown[]) => unknown } };
            };
          }
        ).comfyAPI.app.app,
    );
    const observer = await page
      .evaluateHandle(createNativeCompileDiagnostics, compiler)
      .finally(() => compiler.dispose().catch(() => undefined));
    let compileTrace:
      | ReturnType<ReturnType<typeof createNativeCompileDiagnostics>["finish"]>
      | undefined;
    try {
      observation.canvasPreparation = await prepareNativeFrameCanvas(
        shell,
        () => queued,
      );
    } finally {
      // CRITICAL: restore before any preflight or queue; collection cannot replace
      // the original preparation failure or overwrite another pack's callback.
      compileTrace = await observer
        .evaluate((trace) => trace.finish())
        .catch(() => undefined);
      observation.nativeCompileTrace = compileTrace ?? {
        schema: "h3.context.native_compile_trace.v1",
        restoration: "unavailable",
      };
      await observer.dispose().catch(() => undefined);
    }
    expect(compileTrace?.restoration).toBe("restored");
    expect(queued).toBe(0);
    const compiled = (await page.evaluate(async () => {
      const app = (window as unknown as { comfyAPI: { app: { app: any } } })
        .comfyAPI.app.app;
      return (await app.graphToPrompt()).output;
    })) as NativeFramePrompt;
    const preflightSelection = nativeFrameSelection(compiled);
    observation.preflightParityFields = nativeFrameParityFields(
      representativeClosing,
      preflightSelection,
    );
    const preflightDigest = createHash("sha256")
      .update(JSON.stringify(preflightSelection))
      .digest("hex");
    observation.preflightParityDigest = preflightDigest;
    // IMPORTANT: verify identical seed/model/prompt/canvas before the public action can queue a baseline.
    expect(preflightDigest).toBe(expectedDigest);
    await shell.locator('[data-h3-focus-key="app-stage-execute"]').click();
    await shell.locator('[data-h3-focus-key="app-stage-action"]').click();
    await expect
      .poll(
        () => {
          if (responseFailure)
            throw new Error("native baseline queue or parity refused");
          return promptId !== undefined;
        },
        { timeout: 120_000 },
      )
      .toBe(true);
    await Promise.all(responseReads);
    expect(responseFailure).toBe(false);
    expect(queued).toBe(1);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            new URL(`/history/${encodeURIComponent(promptId!)}`, hostUrl).href,
          );
          expect(response.status()).toBe(200);
          const history = (await response.json())[promptId!];
          if (history?.status?.status_str === "error")
            throw new Error("native baseline execution failed");
          return history?.status?.status_str;
        },
        { timeout: 40 * 60_000, intervals: [1000] },
      )
      .toBe("success");
    await expect
      .poll(() => supportedHostQueueCounts(page))
      .toEqual({ running: 0, pending: 0 });
    await mkdir(mediaRoot, { recursive: true });
    const directory = resolve(mediaRoot, "native-l2va-s8");
    await mkdir(directory, { recursive: false });
    observation.originalCopy = await copyNativeFrameOutput(
      page,
      promptId!,
      directory,
      "baseline.mp4",
    );
    observation.status = "generated";
  } catch (error) {
    observation.status = "failed";
    observation.failureType = error instanceof Error ? error.name : "unknown";
    throw error;
  } finally {
    observation.queuedCount = queued;
    observation.canvasPreparationTerminal = await nativeFrameCanvasState(
      shell,
    ).catch(() => "unavailable");
    await writeFile(
      resolve(evidence, "native-baseline-observation.json"),
      JSON.stringify(observation, null, 2),
      { flag: "wx" },
    );
  }
});
