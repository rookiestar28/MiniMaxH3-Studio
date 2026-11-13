import { describe, expect, it, vi } from "vitest";
import {
  captureSequenceMediaBindings,
  reobserveSequenceMediaBindings,
  captureQualifiedSequenceMediaBindings,
} from "../src/host/sequenceMediaCapture";
import { H3_NODE_TYPES } from "../src/host/graphAdapter";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spliceContextPipeline,
  type Json,
} from "../src/host/templateMaterialization";
import { syntheticTemplate } from "./support/templateFixture";
import { decodeSequenceMediaBindingSet } from "../src/host/sequenceMediaBindings";

const asset = { asset_id: "first_frame_1", role: "first_frame", kind: "image" };
function graphs(cropped = true) {
  const region = { x: 2, y: 4, width: 64, height: 96 };
  const endpoint = cropped ? "crop" : "loader";
  return {
    visible: {
      nodes: [
        {
          id: "registry",
          type: H3_NODE_TYPES.referenceRegistry,
          inputs: [{ name: "first_frame", link: 2 }],
        },
        {
          id: "loader",
          type: "LoadImage",
          widgets_values: ["synthetic/source.png", "image"],
        },
        ...(cropped
          ? [
              {
                id: "crop",
                type: "ImageCropV2",
                inputs: [{ name: "image", link: 1 }],
                widgets_values: [region],
              },
            ]
          : []),
      ],
      links: [
        ...(cropped ? [[1, "loader", 0, "crop", 0, "IMAGE"]] : []),
        [2, endpoint, 0, "registry", 0, "IMAGE"],
      ],
    },
    compiled: {
      output: {
        registry: {
          class_type: String(H3_NODE_TYPES.referenceRegistry),
          inputs: { first_frame: [endpoint, 0] },
        },
        loader: {
          class_type: "LoadImage",
          inputs: { image: "synthetic/source.png" },
        },
        ...(cropped
          ? {
              crop: {
                class_type: "ImageCropV2",
                inputs: { image: ["loader", 0], crop_region: region },
              },
            }
          : {}),
      },
      workflow: {},
    },
  };
}
const receipt = () => ({
  schema: "h3.context.input_geometry.receipt.v2" as const,
  receipt_handle: "ig_" + "a".repeat(40),
  source_fingerprint: "sha256:" + "b".repeat(64),
});

function qualifiedGraphs() {
  const { visible, compiled } = graphs(false);
  return {
    visible: {
      ...visible,
      nodes: [
        ...visible.nodes,
        {
          id: "shell",
          type: H3_NODE_TYPES.productShell,
          inputs: [{ name: "report", type: "REPORT", link: 3 }],
        },
        {
          id: "validator",
          type: H3_NODE_TYPES.validator,
          inputs: [{ name: "plan", type: "PLAN", link: 4 }],
        },
        {
          id: "plan",
          type: H3_NODE_TYPES.plan,
          inputs: [{ name: "reference_registry", type: "REGISTRY", link: 5 }],
        },
      ],
      links: [
        ...visible.links,
        [3, "validator", 1, "shell", 0, "REPORT"],
        [4, "plan", 0, "validator", 0, "PLAN"],
        [5, "registry", 0, "plan", 0, "REGISTRY"],
      ],
    },
    compiled: {
      output: {
        ...compiled.output,
        shell: {
          class_type: H3_NODE_TYPES.productShell,
          inputs: { report: ["validator", 1] },
        },
        validator: {
          class_type: H3_NODE_TYPES.validator,
          inputs: { plan: ["plan", 0] },
        },
        plan: {
          class_type: H3_NODE_TYPES.plan,
          inputs: { reference_registry: ["registry", 0] },
        },
      },
      workflow: {},
    },
  };
}

describe("qualified Start media capture", () => {
  it("uses only the imported context's exact ProductShell-to-Plan Registry", async () => {
    const { visible, compiled } = qualifiedGraphs();
    const observe = vi.fn(async () => receipt());
    const captured = await captureQualifiedSequenceMediaBindings(
      visible,
      compiled,
      "shell",
      [asset],
      observe,
    );
    expect(captured.entries[0].registry_endpoint.node_id).toBe("registry");
    expect(observe).toHaveBeenCalledTimes(1);
  });
  it.each(["shell", "validator", "plan"])(
    "refuses a missing or detached %s before file observation",
    async (id) => {
      const { visible, compiled } = qualifiedGraphs();
      visible.nodes = visible.nodes.filter((row) => row.id !== id);
      const observe = vi.fn(async () => receipt());
      await expect(
        captureQualifiedSequenceMediaBindings(
          visible,
          compiled,
          "shell",
          [asset],
          observe,
        ),
      ).rejects.toThrow("sequence_media_unavailable");
      expect(observe).not.toHaveBeenCalled();
    },
  );
  it("refuses compiled-only Registry redirection before file observation", async () => {
    const { visible, compiled } = qualifiedGraphs();
    compiled.output.plan.inputs.reference_registry = ["unrelated", 0];
    const observe = vi.fn(async () => receipt());
    await expect(
      captureQualifiedSequenceMediaBindings(
        visible,
        compiled,
        "shell",
        [asset],
        observe,
      ),
    ).rejects.toThrow("sequence_media_changed");
    expect(observe).not.toHaveBeenCalled();
  });
});

describe("sequence declared media capture", () => {
  it.each([false, true])(
    "captures exact declared LoadImage with crop=%s once",
    async (cropped) => {
      const { visible, compiled } = graphs(cropped);
      const observe = vi.fn(async () => receipt());
      const result = await captureSequenceMediaBindings(
        visible,
        compiled,
        "registry",
        [asset],
        observe,
      );
      expect(observe).toHaveBeenCalledExactlyOnceWith({
        schema: "h3.context.input_geometry.request.v2",
        locator: "synthetic/source.png",
      });
      expect(result.entries[0].loader_node_id).toBe("loader");
      expect(result.entries[0].transform?.node_id ?? null).toBe(
        cropped ? "crop" : null,
      );
      expect(result.entries[0].registry_endpoint.source_node_id).toBe(
        cropped ? "crop" : "loader",
      );
    },
  );
  it.each([
    "crop_region",
    "source",
    "crop_added",
    "crop_removed",
    "registry_endpoint",
  ])("refuses changed %s", async (change) => {
    const before = graphs(change !== "crop_added");
    const captured = await captureSequenceMediaBindings(
      before.visible,
      before.compiled,
      "registry",
      [asset],
      async () => receipt(),
    );
    const after = graphs(change !== "crop_removed");
    if (change === "crop_region") {
      after.compiled.output.crop!.inputs.crop_region.x = 3;
    }
    if (change === "source") {
      after.visible.nodes[1]!.widgets_values = ["synthetic/other.png", "image"];
      after.compiled.output.loader.inputs.image = "synthetic/other.png";
    }
    if (change === "registry_endpoint")
      after.compiled.output.registry.inputs.first_frame = ["loader", 0];
    await expect(
      reobserveSequenceMediaBindings(
        captured,
        after.visible,
        after.compiled,
        async () => receipt(),
      ),
    ).rejects.toThrow("sequence_media_changed");
  });
  it.each(["loader", "crop"])("refuses missing %s", async (id) => {
    const { visible, compiled } = graphs();
    const captured = await captureSequenceMediaBindings(
      visible,
      compiled,
      "registry",
      [asset],
      async () => receipt(),
    );
    visible.nodes = visible.nodes.filter((row) => row.id !== id);
    await expect(
      reobserveSequenceMediaBindings(captured, visible, compiled, async () =>
        receipt(),
      ),
    ).rejects.toThrow("sequence_media_unavailable");
  });
  it("compares renewed file receipts without retaining transient handles", async () => {
    const { visible, compiled } = graphs();
    const captured = await captureSequenceMediaBindings(
      visible,
      compiled,
      "registry",
      [asset],
      async () => receipt(),
    );
    const renewed = { ...receipt(), receipt_handle: "ig_" + "c".repeat(40) };
    expect(
      (
        await reobserveSequenceMediaBindings(
          captured,
          visible,
          compiled,
          async () => renewed,
        )
      ).entries[0].source_identity,
    ).toEqual(renewed);
    await expect(
      reobserveSequenceMediaBindings(captured, visible, compiled, async () => ({
        ...renewed,
        source_fingerprint: "sha256:" + "d".repeat(64),
      })),
    ).rejects.toThrow("sequence_media_changed");
  });
  it.each([
    "empty",
    "wrong_kind",
    "wrong_loader",
    "wrong_registry",
    "unconnected",
  ])("rejects %s before observing", async (change) => {
    const { visible, compiled } = graphs(false);
    const observe = vi.fn(async () => receipt());
    if (change === "empty") visible.nodes[1]!.widgets_values = [""];
    if (change === "wrong_loader")
      compiled.output.loader.class_type = "LoadVideo";
    if (change === "wrong_registry")
      compiled.output.registry.class_type = "Other";
    if (change === "unconnected") visible.links = [];
    await expect(
      captureSequenceMediaBindings(
        visible,
        compiled,
        "registry",
        [{ ...asset, kind: change === "wrong_kind" ? "video" : "image" }],
        observe,
      ),
    ).rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
  });
});

describe("native crop registration", () => {
  it("captures the crop produced by the existing real splice path", async () => {
    const result = spliceContextPipeline(
      syntheticTemplate("video_minimax_h3_i2v"),
      {
        taskMode: "i2va",
        userIntent: "A kite.",
        durationSeconds: 6,
        media: {
          firstFrame: {
            type: "LoadImage",
            widgetValues: ["synthetic/source.png", "image"],
            crop: {
              x: 2,
              y: 4,
              w: 64,
              h: 96,
              sourceWidth: 128,
              sourceHeight: 128,
            },
          },
        },
      },
    );
    const nodes = result.workflow.nodes as Json[];
    const edges = result.workflow.links as unknown[][];
    const registry = nodes.find(
      (node) => node.type === H3_NODE_TYPES.referenceRegistry,
    )!;
    const output = Object.fromEntries(
      nodes.map((node) => {
        const inputs: Json = {};
        for (const port of (node.inputs ?? []) as Json[]) {
          const edge = edges.find((edge) => edge[0] === port.link);
          if (edge) inputs[String(port.name)] = [String(edge[1]), edge[2]];
        }
        if (node.type === "LoadImage")
          inputs.image = (node.widgets_values as unknown[])[0];
        if (node.type === "ImageCropV2")
          inputs.crop_region = (node.widgets_values as unknown[])[0];
        return [String(node.id), { class_type: node.type, inputs }];
      }),
    );
    const captured = await captureSequenceMediaBindings(
      result.workflow,
      { output, workflow: {} },
      String(registry.id),
      [asset],
      async () => receipt(),
    );
    expect(captured.entries[0]!.transform!.class_type).toBe("ImageCropV2");
    const backend = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../comfyui_h3_context/adapters/sequence_media_bindings.py",
      ),
      "utf8",
    );
    expect(
      backend.match(/SEQUENCE_MEDIA_CROP_NODE_TYPE = "([^"]+)"/)?.[1],
    ).toBe(captured.entries[0]!.transform!.class_type);
    expect(captured.entries[0]!.transform!.region).toEqual({
      x: 2,
      y: 4,
      width: 64,
      height: 96,
    });
    const invented = structuredClone(captured);
    (invented.entries[0]!.transform as { class_type: string }).class_type =
      "ImageCropByRegion";
    expect(() => decodeSequenceMediaBindingSet(invented)).toThrow(
      "sequence_media_binding_invalid",
    );
  });

  it("refuses the invented crop class before observing any source", async () => {
    const { visible, compiled } = graphs(true);
    visible.nodes.find((node) => node.id === "crop")!.type =
      "ImageCropByRegion";
    compiled.output.crop!.class_type = "ImageCropByRegion";
    const observe = vi.fn(async () => receipt());
    await expect(
      captureSequenceMediaBindings(
        visible,
        compiled,
        "registry",
        [asset],
        observe,
      ),
    ).rejects.toThrow("sequence_media_changed");
    expect(observe).not.toHaveBeenCalled();
  });
});
