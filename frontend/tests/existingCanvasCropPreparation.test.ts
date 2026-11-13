import { describe, expect, it, vi } from "vitest";
import {
  createAppModeController,
  type AppModeCompiledPrompt,
  type AppModeInputs,
  type ManagedAppModePreflight,
} from "../src/host/appMode";
import { buildManagedAppModePreparation } from "../src/host/appModeManagedPreparation";
import { IMAGE_CROP_REGION_TYPE } from "../src/host/imageCropCapability";
import {
  CROP_FIXTURE_REQUEST,
  cropPreparedCompiledPrompt,
  interposeImageCrops,
  type CompiledFixtureNode,
} from "./support/cropPreparedPrompt";
import { loadAvailableProfile } from "./support/generationProfileFixture";
import { hostCompiledPrompt } from "./support/hostCompiledPrompt";
import { fixtureBackedAppModeHost } from "./support/hostSeamTestDouble";
import { createQualifiedBasePrompt } from "./support/qualifiedBasePrompt";
import { acceptedQueueResponse } from "./support/queuePromptTestDouble";
import { compileSequenceWorkflow } from "./support/sequenceCompileFixture";
import { loadSyntheticTemplate, type Json } from "./support/templateFixture";

const UNMANAGED =
  "the Product Shell bootstrap contains an unmanaged dependency";
const GRAPH = `sha256:${"a".repeat(64)}`;
const ownedGraph = Object.freeze({
  nodeIds: Object.freeze(["1", "8", "45"]),
  linkIds: Object.freeze(["15", "17", "18"]),
  anchorNodeId: "6",
  fingerprint: `sha256:${"b".repeat(64)}`,
});
const modes = ["i2va", "fl2va", "l2va", "ref2va"] as const;

// On the existing route the crop lives only on the prepared canvas: the Start request has none.
function startInputs(inputs: AppModeInputs): AppModeInputs {
  const { image_crops: _requestCrops, ...rest } = inputs;
  return rest;
}

function prepare(
  compiled: AppModeCompiledPrompt,
  inputs: AppModeInputs,
  route: "new" | "replace" | "existing" = "existing",
): ManagedAppModePreflight {
  return buildManagedAppModePreparation(
    compiled,
    startInputs(inputs),
    route,
    GRAPH,
    ownedGraph,
  );
}

function outcome(run: () => unknown) {
  try {
    run();
    return { result: "prepared" };
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    return { result: "refused", code: value.code, message: value.message };
  }
}
// AppModeError prefixes its message with the code.
const refused = {
  result: "refused",
  code: "compile_failed",
  message: `compile_failed: ${UNMANAGED}`,
};

function identity(prepared: ManagedAppModePreflight) {
  return {
    model_fingerprint: prepared.observation.model_fingerprint,
    runtime_fingerprint: prepared.observation.runtime_fingerprint,
    compiled_prompt_fingerprint:
      prepared.observation.compiled_prompt_fingerprint,
    bootstrap: prepared.bootstrap.output,
  };
}

// The native frontend hands widget values out as reactive proxies; the gate reads values only.
function withProxyRegions(output: Record<string, CompiledFixtureNode>) {
  for (const node of Object.values(output))
    if (node.class_type === "ImageCropV2")
      node.inputs.crop_region = new Proxy(
        node.inputs.crop_region as Record<string, number>,
        {},
      );
}

function registryOf(output: Record<string, CompiledFixtureNode>) {
  return Object.entries(output).find(([, node]) =>
    node.class_type.endsWith("ReferenceRegistry"),
  )!;
}

describe("managed preparation of a crop-prepared existing single clip", () => {
  it.each(modes)(
    "admits the %s crop-prepared prompt with plain and proxy regions",
    (mode) => {
      const plain = cropPreparedCompiledPrompt(mode);
      const proxied = cropPreparedCompiledPrompt(mode);
      withProxyRegions(proxied.output);
      const preparedPlain = prepare(plain.compiled, plain.inputs);
      const preparedProxy = prepare(proxied.compiled, proxied.inputs);
      const bootstrap = preparedPlain.bootstrap.output;
      const [registryId] = registryOf(plain.output);
      expect(Object.keys(bootstrap)).toContain(registryId);
      for (const [i, loader] of plain.loaders.entries()) {
        const cropId = String(60 + i);
        expect(bootstrap[String(loader)]).toMatchObject({
          class_type: "LoadImage",
        });
        expect(bootstrap[cropId]).toEqual({
          class_type: "ImageCropV2",
          inputs: {
            image: [String(loader), 0],
            crop_region: { x: 8, y: 16, width: 320, height: 240 },
          },
        });
        expect(
          Object.values(
            (bootstrap[registryId] as { inputs: Record<string, unknown> })
              .inputs,
          ),
        ).toContainEqual([cropId, 0]);
      }
      expect(identity(preparedProxy)).toEqual(identity(preparedPlain));
    },
  );

  it("admits a region the user edited to other valid values", () => {
    const { compiled, inputs, output } = cropPreparedCompiledPrompt("i2va");
    output["60"]!.inputs.crop_region = {
      x: 100,
      y: 40,
      width: 200,
      height: 180,
    };
    expect(prepare(compiled, inputs).productShellNodeId).toBe("8");
  });

  it("admits a native anchor the operator rewired to the raw loader", () => {
    const { compiled, inputs, output } = cropPreparedCompiledPrompt("i2va");
    output["6"]!.inputs.first_frame = ["9", 0];
    expect(prepare(compiled, inputs).productShellNodeId).toBe("8");
  });

  it("admits a malformed crop node outside the Product Shell closure", () => {
    const { compiled, inputs, output } = cropPreparedCompiledPrompt("i2va", {
      crops: false,
    });
    output["70"] = {
      class_type: "ImageCropV2",
      inputs: { image: ["9", 1], crop_region: { x: -5, width: "wide" } },
    };
    output["6"]!.inputs.first_frame = ["70", 0];
    expect(prepare(compiled, inputs).productShellNodeId).toBe("8");
  });

  it("admits two different crops of one loader as first and last frame", () => {
    const { compiled, inputs, output } = cropPreparedCompiledPrompt("fl2va");
    output["61"]!.inputs.image = ["9", 0];
    output["61"]!.inputs.crop_region = { x: 0, y: 0, width: 64, height: 48 };
    const prepared = prepare(compiled, inputs);
    const [registryId] = registryOf(output);
    expect(
      (prepared.bootstrap.output[registryId] as { inputs: unknown }).inputs,
    ).toMatchObject({ first_frame: ["60", 0], last_frame: ["61", 0] });
  });

  it.each([
    [32, "prepared"],
    [31, "refused"],
  ] as const)("width %i at the lower bound is %s", (width, result) => {
    const { compiled, inputs, output } = cropPreparedCompiledPrompt("i2va");
    (output["60"]!.inputs.crop_region as Record<string, number>).width = width;
    if (result === "prepared")
      expect(prepare(compiled, inputs).productShellNodeId).toBe("8");
    else expect(outcome(() => prepare(compiled, inputs))).toEqual(refused);
  });

  it.each([
    [16064, "prepared"],
    [16065, "refused"],
  ] as const)("x %i with width 320 at the upper bound is %s", (x, result) => {
    const { compiled, inputs, output } = cropPreparedCompiledPrompt("i2va");
    (output["60"]!.inputs.crop_region as Record<string, number>).x = x;
    if (result === "prepared")
      expect(prepare(compiled, inputs).productShellNodeId).toBe("8");
    else expect(outcome(() => prepare(compiled, inputs))).toEqual(refused);
  });

  it.each([
    "crop over a crop",
    "image slot 1",
    "extra input key",
    "linked crop_region",
    "missing region key",
    "extra region key",
    "non-integer region value",
  ])("refuses a crop node in the closure with %s", (mutation) => {
    const { compiled, inputs, output } = cropPreparedCompiledPrompt("i2va");
    const crop = output["60"]!.inputs;
    const region = crop.crop_region as Record<string, number>;
    if (mutation === "crop over a crop") {
      output["61"] = {
        class_type: "ImageCropV2",
        inputs: { image: ["9", 0], crop_region: { ...region } },
      };
      crop.image = ["61", 0];
    }
    if (mutation === "image slot 1") crop.image = ["9", 1];
    if (mutation === "extra input key") crop.extra = 1;
    if (mutation === "linked crop_region") crop.crop_region = ["9", 0];
    if (mutation === "missing region key") delete region.height;
    if (mutation === "extra region key") region.z = 0;
    if (mutation === "non-integer region value") region.x = 8.5;
    expect(outcome(() => prepare(compiled, inputs))).toEqual(refused);
  });

  it.each(["new", "replace"] as const)(
    "refuses the same valid crop-prepared prompt on the %s route",
    (route) => {
      const { compiled, inputs } = cropPreparedCompiledPrompt("fl2va");
      expect(outcome(() => prepare(compiled, inputs, route))).toEqual(refused);
    },
  );

  it("keeps a nine-crop Ref2VA closure inside the node bound", ({ task }) => {
    const sources = Array.from({ length: 9 }, (_, i) => String(17 + i));
    const inputs: AppModeInputs = {
      task_mode: "ref2va",
      user_intent: "A kite.",
      duration_milliseconds: 5167,
      frame_count: 124,
      reference_image_sources: sources,
    };
    const image = { class_type: "LoadImage", inputs: { image: "fixture.png" } };
    const output = createQualifiedBasePrompt(
      inputs,
      { reference_images: sources.map(() => image) },
      { sharedDurationSource: true },
    ) as Record<string, CompiledFixtureNode>;
    const loaders = Object.entries(output)
      .filter(([, node]) => node.class_type === "LoadImage")
      .map(([id]) => Number(id));
    expect(loaders).toHaveLength(9);
    interposeImageCrops(output, loaders);
    const prepared = prepare(hostCompiledPrompt(output, {}), inputs);
    const size = Object.keys(prepared.bootstrap.output).length;
    // Recorded for the acceptance record through the JSON reporter.
    (task.meta as Record<string, unknown>).nineCropClosureSize = size;
    expect(size).toBeLessThan(128);
  });
});

describe("accepted canvases keep their prepared identities", () => {
  function outOfClosureCrop() {
    const fixture = cropPreparedCompiledPrompt("i2va", { crops: false });
    fixture.output["70"] = {
      class_type: "ImageCropV2",
      inputs: {
        image: ["9", 0],
        crop_region: { x: 8, y: 16, width: 320, height: 240 },
      },
    };
    fixture.output["6"]!.inputs.first_frame = ["70", 0];
    return fixture;
  }
  const pinned = (prepared: ManagedAppModePreflight) => ({
    model_fingerprint: prepared.observation.model_fingerprint,
    runtime_fingerprint: prepared.observation.runtime_fingerprint,
    bootstrap_keys: Object.keys(prepared.bootstrap.output).sort(),
  });

  it("pins the no-crop control", () => {
    const { compiled, inputs } = cropPreparedCompiledPrompt("i2va", {
      crops: false,
    });
    expect(pinned(prepare(compiled, inputs))).toEqual(NO_CROP_CONTROL);
  });

  it("pins the out-of-closure crop control", () => {
    const { compiled, inputs } = outOfClosureCrop();
    expect(pinned(prepare(compiled, inputs))).toEqual(OUT_OF_CLOSURE_CONTROL);
  });
});

// Taken on the unchanged base 8b1a9cf8 (R1 literal capture); an accepted canvas keeps them.
const CONTROL_BOOTSTRAP_KEYS = ["1", "11", "2", "3", "4", "45", "5", "8", "9"];
const NO_CROP_CONTROL = {
  model_fingerprint:
    "sha256:81d5653575b387ed6b34b9d75df0315615a93991e0b0600669cfccf5a2e3b26d",
  runtime_fingerprint:
    "sha256:c002dcc2d2fe59e1d1d205757c5aef989ecc3df4d12b70d9dbc6ff33a57d752b",
  bootstrap_keys: CONTROL_BOOTSTRAP_KEYS,
};
const OUT_OF_CLOSURE_CONTROL = {
  model_fingerprint:
    "sha256:3d9421c07d75c80c3f67c33fe5ba742756a2f0a57f4b6f8ca001cc463d292088",
  runtime_fingerprint:
    "sha256:8323cc7b914c6d2c039236d79aa0cd8a41646760a1389d2e317f5b5c6289e07e",
  bootstrap_keys: CONTROL_BOOTSTRAP_KEYS,
};

describe("sidebar Start on a canvas that Prepare canvas cropped", () => {
  const prepareInputs: AppModeInputs = {
    task_mode: "i2va",
    user_intent: "A kite.",
    duration_milliseconds: 5167,
    frame_count: 124,
    first_frame_source: "17",
  };

  function harness() {
    let visible: Json = {
      nodes: [
        {
          id: 17,
          type: "LoadImage",
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
          widgets_values: ["fixture.png", "image"],
        },
      ],
      links: [],
    };
    const loadGraphData = vi.fn((value: unknown) => {
      visible = structuredClone(value) as Json;
    });
    // The host lowers the visible graph it holds, in its own envelope key order.
    const graphToPrompt = vi.fn(async (value?: unknown) => {
      const lowered = compileSequenceWorkflow(
        (value ?? visible) as Json,
        false,
      );
      return hostCompiledPrompt(lowered.output, lowered.workflow);
    });
    const queuePrompt = vi.fn(async (_batch: number, _prompt: unknown) =>
      acceptedQueueResponse(41),
    );
    const activeWorkflow = {};
    const { app, api } = fixtureBackedAppModeHost(
      {
        extensionManager: {
          workflow: { activeWorkflow, openWorkflows: [activeWorkflow] },
        },
        loadApiJson: vi.fn(),
        loadGraphData,
        graphToPrompt,
        graph: { serialize: () => visible },
      },
      { queuePrompt, fileURL: (path: string) => path },
    );
    const controller = createAppModeController(app, api, {
      loadTemplate: loadSyntheticTemplate,
      loadProfile: loadAvailableProfile,
      readNodeDefinitions: () => ({
        crop: {
          nodeData: {
            name: "ImageCropV2",
            input: {
              required: {
                image: ["IMAGE"],
                crop_region: [IMAGE_CROP_REGION_TYPE],
              },
            },
          },
        },
      }),
      measureSourceImage: vi.fn(async () => ({ width: 640, height: 480 })),
    });
    const prepareManaged = vi.fn(async (prepared: ManagedAppModePreflight) => ({
      expectedIdentity: {
        graphFingerprint: prepared.observation.graph_fingerprint,
        compiledPromptFingerprint:
          prepared.observation.compiled_prompt_fingerprint,
      },
      onQueueSubmitted: () => undefined,
      onQueueAccepted: () => undefined,
      onQueueFailed: () => undefined,
    }));
    return {
      controller,
      loadGraphData,
      queuePrompt,
      prepareManaged,
      visible: () => visible,
    };
  }

  async function startOnPreparedCanvas(cropped: boolean) {
    const row = harness();
    if (cropped) {
      await row.controller.cropSources.open("17");
      row.controller.cropSources.apply("17", CROP_FIXTURE_REQUEST);
    }
    await row.controller.prepareCanvas(
      cropped
        ? { ...prepareInputs, image_crops: { "17": CROP_FIXTURE_REQUEST } }
        : prepareInputs,
      { replaceExisting: true },
    );
    expect(row.loadGraphData).toHaveBeenCalledOnce();
    const prepared = structuredClone(row.visible());
    const crops = (prepared.nodes as Json[]).filter(
      (node) => node.type === "ImageCropV2",
    );
    expect(crops).toHaveLength(cropped ? 1 : 0);
    const result = await row.controller.start(prepareInputs, {
      useExisting: true,
      prepareManaged: row.prepareManaged,
    });
    return { row, prepared, result };
  }

  it.each([false, true])(
    "starts once with a crop on the prepared canvas: %s",
    async (cropped) => {
      const { row, prepared, result } = await startOnPreparedCanvas(cropped);
      expect(result).toMatchObject({
        route: "existing",
        queuePromptId: expect.any(String),
      });
      expect(row.prepareManaged).toHaveBeenCalledOnce();
      expect(row.queuePrompt).toHaveBeenCalledOnce();
      // Prepare canvas writes once; the existing-route Start makes its one validated write of
      // the same graph. Content equality is what "not rewritten" means here.
      expect(row.loadGraphData).toHaveBeenCalledTimes(2);
      expect(row.visible()).toEqual(prepared);
      const queued = row.queuePrompt.mock.calls[0]![1] as {
        output: Record<string, CompiledFixtureNode>;
      };
      const queuedCrops = Object.values(queued.output).filter(
        (node) => node.class_type === "ImageCropV2",
      );
      expect(queuedCrops).toHaveLength(cropped ? 1 : 0);
    },
  );
});
