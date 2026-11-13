import { compileSequenceWorkflow } from "./support/sequenceCompileFixture";
import { describe, expect, it, vi } from "vitest";
import {
  createAppModeController,
  type ManagedAppModePreflight,
  type ProductionCanonicalLowering,
} from "../src/host/appMode";
import { loadAvailableProfile } from "./support/generationProfileFixture";
import { fixtureBackedAppModeHost } from "./support/hostSeamTestDouble";
import { acceptedQueueResponse } from "./support/queuePromptTestDouble";
import { preparedSequenceMediaFixture } from "./support/preparedSequenceMediaFixture";
import { nativeCanvasSequenceTemplateFixture } from "./support/nativeCanvasSequenceTemplateFixture";
import type { Json } from "./support/templateFixture";
import type { InputGeometryRequest } from "../src/host/inputGeometry";
import { isSafeCompiledPromptEnvelope } from "../src/host/appModeContract";
import {
  isCompatibleExistingPrompt,
  compiledPromptMatchesRequestedRoute,
} from "../src/host/appModeExistingRoute";
import type { SpliceMediaIds } from "../src/host/templateGraphTopology";
import { AppModeError } from "../src/host/appModeError";
import { decodeSequenceFailureAttribution } from "../src/host/managedSequenceDiagnostics";

function environment(
  task: "t2va" | "i2va" | "l2va" | "fl2va",
  global: "i2va" | "l2va" | "fl2va",
  cropped: boolean,
  defect?:
    | "source_await"
    | "crop_await"
    | "guide_await"
    | "prepare_await"
    | "write"
    | "wrong_loader"
    | "missing_observer"
    | "root_control"
    | "crop_alias_await",
  prompt?: string,
  nativeCropWidgetPersistence?: "detached" | "root",
) {
  const { inputs, prepared } = preparedSequenceMediaFixture(
    task,
    global,
    cropped,
  );
  if (prompt !== undefined) inputs.user_intent = prompt;
  let visible: Json = { nodes: [], links: [] };
  let candidate: Json | undefined;
  const diagnostics: boolean[][] = [];
  const mutate = (type: string, change: (node: Json) => void) =>
    change(
      ((candidate ?? visible).nodes as Json[]).find(
        (node) => node.type === type,
      )!,
    );
  const loadGraphData = vi.fn((value: unknown) => {
    visible = structuredClone(value) as Json;
    if (nativeCropWidgetPersistence) {
      for (const node of visible.nodes as Json[]) {
        if (node.type === "ImageCropV2")
          (node.widgets_values as unknown[]).push(0, 0, 512, 512);
      }
    }
    if (defect === "write" && (visible.nodes as Json[]).length) {
      (visible.nodes as Json[]).find(
        (node) => node.type === "LoadImage",
      )!.widgets_values = ["synthetic/changed.png", "image"];
    }
  });
  const graphToPrompt = vi.fn(async (value?: unknown) => {
    candidate = (value ?? visible) as Json;
    const result = compileSequenceWorkflow(
      candidate,
      defect === "crop_alias_await",
    );
    if (defect === "crop_alias_await") {
      const nodes = candidate.nodes as Json[];
      const loader = nodes.find((node) => node.type === "LoadImage")!;
      const crop = nodes.find((node) => node.type === "ImageCropV2")!;
      const region = (crop.widgets_values as unknown[])[0] as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const ids: SpliceMediaIds = {
        firstFrame: Number(loader.id),
        referenceImages: [],
        referenceVideos: [],
        referenceAudios: [],
        retainedCrops: {
          [String(loader.id)]: { nodeId: Number(crop.id), region },
        },
      };
      const compiledRegion = (
        result.output[String(crop.id)] as { inputs: Record<string, unknown> }
      ).inputs.crop_region;
      diagnostics.push([
        isSafeCompiledPromptEnvelope(result),
        isCompatibleExistingPrompt(result, "prepared", undefined, prepared),
        compiledPromptMatchesRequestedRoute(
          result,
          inputs,
          "prepared",
          ids,
          undefined,
          lowering,
          false,
          prepared,
        ),
        compiledRegion === region,
      ]);
    }
    if (defect === "wrong_loader")
      Object.values(result.output as Record<string, Json>).find(
        (node) => node.class_type === "LoadImage",
      )!.class_type = "LoadVideo";
    return result;
  });
  const queuePrompt = vi.fn(async (_batch: number, _prompt: unknown) =>
    acceptedQueueResponse(31),
  );
  const activeWorkflow = {};
  const bound = fixtureBackedAppModeHost(
    {
      extensionManager: {
        workflow: { activeWorkflow, openWorkflows: [activeWorkflow] },
      },
      loadApiJson: vi.fn(),
      loadGraphData,
      graphToPrompt,
      graph: { serialize: () => visible },
    },
    { queuePrompt },
  );
  const onQueueFailed = vi.fn();
  const prepareManaged = vi.fn(async (value: ManagedAppModePreflight) => {
    if (defect === "prepare_await")
      mutate("LoadImage", (node) => {
        (node.widgets_values as unknown[])[0] = "synthetic/changed.png";
      });
    return {
      expectedIdentity: {
        graphFingerprint: value.observation.graph_fingerprint,
        compiledPromptFingerprint:
          value.observation.compiled_prompt_fingerprint,
      },
      onQueueSubmitted: vi.fn(),
      onQueueAccepted: vi.fn(),
      onQueueFailed,
    };
  });
  const observeSourceIdentity = vi.fn(async (request: InputGeometryRequest) => {
    const entry = prepared.bindings!.entries.find(
      (row) => row.locator === request.locator,
    )!;
    if (defect === "source_await")
      mutate("LoadImage", (node) => {
        (node.widgets_values as unknown[])[0] = "synthetic/changed.png";
      });
    if (defect === "crop_await" || defect === "crop_alias_await")
      mutate("ImageCropV2", (node) => {
        (node.widgets_values as Json[])[0]!.x = 17;
      });
    if (defect === "guide_await")
      mutate("MiniMaxH3AddGuide", (node) => {
        (node.widgets_values as unknown[])[0] = 157;
      });
    return {
      ...entry.source_identity,
      receipt_handle:
        "ig_" + "n".repeat(40) + (entry.role === "first_frame" ? "f" : "l"),
    };
  });
  const lowering: ProductionCanonicalLowering = {
    schema:
      task === "t2va"
        ? "h3.context.production_canonical_lowering.v1"
        : "h3.context.production_canonical_lowering.v2",
    canonicalPrompt: inputs.user_intent,
    baseReportFingerprint: "sha256:" + "7".repeat(64),
    baseReportRevision: 0,
    overrideRevision: 1,
    reason: "Materialize approved Production segment prompt",
    ...(task === "t2va"
      ? {}
      : {
          taskMode: task,
          bindingRoles:
            task === "fl2va"
              ? ["first_frame", "last_frame"]
              : [task === "i2va" ? "first_frame" : "last_frame"],
        }),
  } as ProductionCanonicalLowering;
  const loadTemplate = async (name: string) => {
    const template = nativeCanvasSequenceTemplateFixture(name);
    const nodes = template.nodes as Json[],
      links = template.links as unknown[][];
    const anchor = nodes.find((node) => node.id === 3)!;
    (anchor.inputs as Json[]).find((port) => port.name === "clip")!.link = 24;
    nodes.find((node) => node.id === 25)!.widgets_values = [
      "synthetic.safetensors",
    ];
    nodes.push({
      id: 27,
      type: "CLIPLoader",
      inputs: [],
      outputs: [{ name: "CLIP", type: "CLIP", links: [24] }],
      widgets_values: ["synthetic.safetensors", "minimax_h3"],
    });
    (nodes.find((node) => node.id === 4)!.inputs as Json[]).push({
      name: "vae",
      type: "VAE",
      link: 25,
    });
    (
      (nodes.find((node) => node.id === 25)!.outputs as Json[])[0]!
        .links as number[]
    ).push(25);
    links.push([24, 27, 0, 3, 0, "CLIP"], [25, 25, 0, 4, 1, "VAE"]);
    template.last_node_id = Math.max(Number(template.last_node_id), 27);
    template.last_link_id = Math.max(Number(template.last_link_id), 25);
    if (
      nativeCropWidgetPersistence === "root" ||
      [
        "source_await",
        "crop_await",
        "guide_await",
        "prepare_await",
        "root_control",
        "crop_alias_await",
      ].includes(defect ?? "")
    )
      template.id = "9117355a-d90f-4f38-86b2-733155c37323";
    return template;
  };
  const controller = createAppModeController(bound.app, bound.api, {
    loadProfile: loadAvailableProfile,
    loadTemplate,
    readNodeDefinitions: () =>
      cropped
        ? {
            ImageCropV2: {
              nodeData: {
                name: "ImageCropV2",
                input: {
                  required: { image: ["IMAGE"], crop_region: ["BOUNDING_BOX"] },
                },
                output: ["IMAGE"],
              },
            },
          }
        : undefined,
    nodeDefinitionReadinessReached: () => cropped,
  });
  return {
    start: () =>
      controller.start(inputs, {
        replaceExisting: true,
        preparedCanonicalPrompt: lowering,
        preparedSequenceMedia: prepared,
        prepareManaged,
        ...(defect === "missing_observer" ? {} : { observeSourceIdentity }),
      }),
    prepareManaged,
    observeSourceIdentity,
    queuePrompt,
    loadGraphData,
    onQueueFailed,
    prepared,
    diagnostics,
  };
}

describe("private retained frame controller chain", () => {
  it.each(["detached", "root"] as const)(
    "queues unchanged retained crop after native helper widget persistence on the %s path",
    async (path) => {
      const subject = environment(
        "i2va",
        "i2va",
        true,
        undefined,
        undefined,
        path,
      );
      await expect(subject.start()).resolves.toMatchObject({
        queuePromptId: expect.any(String),
      });
      expect(subject.prepareManaged).toHaveBeenCalledOnce();
      expect(subject.observeSourceIdentity).toHaveBeenCalledOnce();
      expect(subject.queuePrompt).toHaveBeenCalledOnce();
      expect(subject.loadGraphData).toHaveBeenCalledOnce();
    },
  );

  it("queues a retained cropped opening frame through the complete controller", async () => {
    const subject = environment("i2va", "i2va", true);
    await expect(subject.start()).resolves.toMatchObject({
      queuePromptId: expect.any(String),
    });
    expect(subject.prepareManaged).toHaveBeenCalledOnce();
    expect(subject.observeSourceIdentity).toHaveBeenCalledOnce();
    expect(subject.queuePrompt).toHaveBeenCalledOnce();
    expect(subject.loadGraphData).toHaveBeenCalledOnce();
    const queued = subject.queuePrompt.mock.calls[0]![1] as {
      output: Record<
        string,
        { class_type: string; inputs: Record<string, unknown> }
      >;
    };
    const crops = Object.entries(queued.output).filter(
      ([, node]) => node.class_type === "ImageCropV2",
    );
    expect(crops).toHaveLength(1);
    const [cropId, crop] = crops[0]!;
    expect(crop.inputs.crop_region).toEqual(
      subject.prepared.bindings!.entries[0]!.transform!.region,
    );
    const [loaderId, output] = crop.inputs.image as [string, number];
    expect(output).toBe(0);
    expect(queued.output[loaderId]!.class_type).toBe("LoadImage");
    const imageConsumers = (source: string) =>
      Object.entries(queued.output).flatMap(([id, node]) =>
        Object.values(node.inputs)
          .filter(
            (value) =>
              Array.isArray(value) && value[0] === source && value[1] === 0,
          )
          .map(() => id),
      );
    expect(imageConsumers(loaderId)).toEqual([cropId]);
    expect(imageConsumers(cropId).length).toBeGreaterThan(0);
  });

  it("preserves only closed source-failure metadata through the actual AppMode conversion", async () => {
    const subject = environment("i2va", "i2va", false, "root_control");
    subject.observeSourceIdentity.mockImplementation(async () => ({
      ...subject.prepared.bindings!.entries[0]!.source_identity,
      source_fingerprint: "sha256:" + "f".repeat(64),
      receipt_handle: "ig_" + "n".repeat(41),
    }));
    let caught: unknown;
    try {
      await subject.start();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppModeError);
    expect(caught).toMatchObject({ code: "sequence_media_changed" });
    expect(decodeSequenceFailureAttribution(caught)).toEqual({
      origin: "renewed-source",
      boundary: "source-observe",
      managedAction: "unattributed",
      httpStatusClass: "unattributed",
    });
    expect(Object.getOwnPropertyNames(caught).sort()).toEqual([
      "code",
      "failureAttribution",
      "message",
      "name",
      "reason",
      "recovery",
      "source",
      "stack",
    ]);
    expect(
      Object.getOwnPropertyDescriptor(caught, "failureAttribution")?.enumerable,
    ).toBe(false);
    expect(subject.queuePrompt).not.toHaveBeenCalled();
  });
  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["l2va", "l2va"],
    ["fl2va", "fl2va"],
    ["t2va", "fl2va"],
  ] as const)(
    "queues the exact 4096-code-point private prompt for %s of %s",
    async (task, global) => {
      const subject = environment(
        task,
        global,
        false,
        undefined,
        "🌟".repeat(4096),
      );
      await expect(subject.start()).resolves.toMatchObject({
        queuePromptId: expect.any(String),
      });
      expect(subject.prepareManaged).toHaveBeenCalledOnce();
      expect(subject.queuePrompt).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "🌟".repeat(4097),
    "synthetic\ud800prompt",
    "synthetic\udc00prompt",
  ])(
    "refuses private invalid Unicode before observation, preparation and queue %#",
    async (prompt) => {
      const subject = environment("i2va", "i2va", false, undefined, prompt);
      await expect(subject.start()).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(subject.observeSourceIdentity).not.toHaveBeenCalled();
      expect(subject.prepareManaged).not.toHaveBeenCalled();
      expect(subject.queuePrompt).not.toHaveBeenCalled();
      expect(subject.loadGraphData).not.toHaveBeenCalled();
    },
  );

  it("queues one freshly observed root-load child with one canvas write", async () => {
    const subject = environment("i2va", "i2va", false, "root_control");
    await expect(subject.start()).resolves.toMatchObject({
      queuePromptId: expect.any(String),
    });
    expect(subject.queuePrompt).toHaveBeenCalledOnce();
    expect(subject.loadGraphData).toHaveBeenCalledOnce();
    expect(subject.observeSourceIdentity).toHaveBeenCalledOnce();
  });

  it("refuses a live crop edit even when the compiled region retains the widget reference", async () => {
    const subject = environment("i2va", "i2va", true, "crop_alias_await");
    const pending = subject.start();
    await pending.catch(() => undefined);
    expect(
      subject.diagnostics,
      "safe envelope, compatibility, private route, retained region alias",
    ).toEqual([[true, true, true, true]]);
    await expect(pending).rejects.toMatchObject({
      code: "sequence_media_changed",
    });
    expect(subject.prepareManaged).not.toHaveBeenCalled();
    expect(subject.queuePrompt).not.toHaveBeenCalled();
    expect(subject.observeSourceIdentity).toHaveBeenCalledOnce();
  });

  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["l2va", "l2va"],
    ["fl2va", "fl2va"],
    ["t2va", "fl2va"],
  ] as const)(
    "queues one freshly observed child %s of %s from retained source authority",
    async (task, global) => {
      const subject = environment(task, global, false);
      await expect(subject.start()).resolves.toMatchObject({
        queuePromptId: expect.any(String),
      });
      expect(subject.prepareManaged).toHaveBeenCalledOnce();
      expect(subject.prepareManaged.mock.calls[0]![0].observation.schema).toBe(
        "h3.context.prepared_graph_observation.v5",
      );
      expect(subject.observeSourceIdentity).toHaveBeenCalledTimes(
        subject.prepared.bindings?.entries.length ?? 0,
      );
      expect(subject.queuePrompt).toHaveBeenCalledOnce();
      expect(subject.loadGraphData).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "source_await",
    "crop_await",
    "guide_await",
    "prepare_await",
    "write",
    "wrong_loader",
    "missing_observer",
  ] as const)("refuses %s before any model queue", async (defect) => {
    const closing = defect === "guide_await";
    const subject = environment(
      closing ? "l2va" : "i2va",
      closing ? "l2va" : "i2va",
      defect === "crop_await",
      defect,
    );
    await expect(subject.start()).rejects.toMatchObject({
      code:
        defect === "wrong_loader" ? "compile_failed" : "sequence_media_changed",
    });
    expect(subject.queuePrompt).not.toHaveBeenCalled();
    if (defect === "prepare_await" || defect === "write")
      expect(subject.onQueueFailed).toHaveBeenCalledWith("not_invoked");
    else expect(subject.prepareManaged).not.toHaveBeenCalled();
  });
});
