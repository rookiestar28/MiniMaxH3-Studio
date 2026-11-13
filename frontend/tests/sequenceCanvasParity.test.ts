import { describe, expect, it, vi } from "vitest";
import { resolveMaterializeRoute } from "../src/host/appModeRoutes";
import type { AppModeInputs } from "../src/host/appModeContract";
import type { Json } from "../src/host/templateGraphTopology";
import { preparedSequenceMediaFixture } from "./support/preparedSequenceMediaFixture";
import { sequenceTemplateFixture } from "./support/sequenceTemplateFixture";
import { compileSequenceWorkflow } from "./support/sequenceCompileFixture";

type Mode = AppModeInputs["task_mode"];
const square = ["1:1 (Square)", 0.4, 32];
const wide = ["16:9 (Widescreen)", 0.4, 32];
const names = ["aspect_ratio", "megapixels", "multiple"];
const nodes = (graph: Json) => graph.nodes as Json[];

// Independent fixtures model the two served native dimension seams, including named values.
function template(
  name: string,
  tuple = name.endsWith("i2v") ? square : wide,
): Json {
  const graph = sequenceTemplateFixture(name.endsWith("i2v") ? "i2va" : "t2va");
  const anchor = nodes(graph).find((node) => node.id === 3)!;
  const inputs = anchor.inputs as Json[];
  for (const [index, key] of ["width", "height"].entries()) {
    const slot = inputs.findIndex((port) => port.name === key);
    inputs[slot]!.link = 24 + index;
    (graph.links as unknown[][]).push([24 + index, 27, index, 3, slot, "INT"]);
  }
  nodes(graph).push({
    id: 27,
    type: "ResolutionSelector",
    inputs: names.map((name) => ({
      name,
      type: name === "aspect_ratio" ? "COMBO" : "FLOAT",
      widget: { name },
      link: null,
    })),
    outputs: [
      { name: "width", type: "INT", links: [24] },
      { name: "height", type: "INT", links: [25] },
    ],
    widgets_values: [...tuple],
    widgets_values_named: Object.fromEntries(
      names.map((name, index) => [name, tuple[index]]),
    ),
  });
  graph.last_node_id = 27;
  graph.last_link_id = 25;
  return graph;
}

function seam(graph: Json) {
  const compiled = compileSequenceWorkflow(graph, false).output as Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  >;
  const anchor = Object.values(compiled).find(
    (node) => node.class_type === "MiniMaxH3ImageToVideo",
  )!;
  const width = anchor.inputs.width as [string, number];
  const height = anchor.inputs.height as [string, number];
  expect(width).toEqual([height[0], 0]);
  expect(height[1]).toBe(1);
  const producer = compiled[width[0]]!;
  if (producer.class_type === "GetImageSize") {
    const scale = compiled[(producer.inputs.image as [string, number])[0]]!;
    const crop = compiled[(scale.inputs.image as [string, number])[0]]!;
    expect(scale.inputs).toMatchObject({
      upscale_method: "nearest-exact",
      megapixels: 0.8,
      resolution_steps: 32,
    });
    expect(crop.class_type).toBe("ImageCropV2");
    return {
      source: "crop",
      scale: scale.inputs.megapixels,
      region: crop.inputs.crop_region,
    };
  }
  expect(producer.class_type).toBe("ResolutionSelector");
  return names.map((key) => producer.inputs[key]);
}

async function resolve(
  task: Mode,
  parent: "fl2va" | "l2va" | "i2va",
  duration = 6,
  load = vi.fn(async (name: string) => template(name)),
  cropped = false,
) {
  const { inputs, prepared } = preparedSequenceMediaFixture(
    task,
    parent,
    cropped,
  );
  const definitions = cropped
    ? {
        ImageCropV2: {
          nodeData: {
            name: "ImageCropV2",
            input: {
              required: { image: ["IMAGE"], crop_region: ["BOUNDING_BOX"] },
            },
          },
        },
      }
    : undefined;
  const result = await resolveMaterializeRoute(
    { nodes: [], links: [] },
    { ...inputs, duration_milliseconds: duration * 1000 },
    {
      signal: undefined,
      artifactScope: undefined,
      preparedCanonicalPrompt: undefined,
      loadTemplate: load,
      readNodeDefinitions: () => definitions,
      nodeDefinitionReadinessReached: () => cropped,
      admitted: { status: "admitted" },
      preparedSequenceMedia: prepared,
    },
  );
  return result.candidateWorkflow as Json;
}

describe("managed parent canvas authority", () => {
  it("fl2va-fixed-26 shares the parent template canvas across i2va t2va l2va", async () => {
    const graphs = await Promise.all(
      (["i2va", "t2va", "l2va"] as const).map((task, index) =>
        resolve(task, "fl2va", [10, 10, 6][index]),
      ),
    );
    expect(graphs.map(seam)).toEqual([square, square, square]);
  });

  it.each([
    ["l2va-reviewed-19", [6, 13]],
    ["l2va-fixed-18", [10, 8]],
  ] as const)(
    "%s gives its opening T2VA child the parent canvas",
    async (_row, durations) => {
      const graphs = await Promise.all(
        (["t2va", "l2va"] as const).map((task, index) =>
          resolve(task, "l2va", durations[index]),
        ),
      );
      expect(graphs.map(seam)).toEqual([square, square]);
    },
  );

  it("i2va-cropped-10 keeps the same retained crop and source sizing for both children", async () => {
    const graphs = await Promise.all(
      (["i2va", "t2va"] as const).map((task) =>
        resolve(task, "i2va", 5, undefined, true),
      ),
    );
    expect(seam(graphs[0]!)).toEqual(seam(graphs[1]!));
    const middle = nodes(graphs[1]!).find(
      (node) => node.type === "MiniMaxH3ImageToVideo",
    )!;
    expect(
      (middle.inputs as Json[]).find((port) => port.name === "first_frame")
        ?.link,
    ).toBeNull();
  });

  it("uses the selector tuple rather than a fixed square dimension and preserves inputs", async () => {
    const authority = template("video_minimax_h3_i2v", [
      "4:3 (Standard)",
      0.7,
      64,
    ]);
    const child = template("video_minimax_h3_t2v");
    const before = structuredClone([authority, child]);
    const load = vi.fn(async (name: string) =>
      name.endsWith("i2v") ? authority : child,
    );
    const graph = await resolve("t2va", "fl2va", 10, load);
    expect(seam(graph)).toEqual(["4:3 (Standard)", 0.7, 64]);
    expect([authority, child]).toEqual(before);
    const selector = nodes(graph).find(
      (node) => node.type === "ResolutionSelector",
    )!;
    expect(selector.widgets_values_named).toEqual({
      aspect_ratio: "4:3 (Standard)",
      megapixels: 0.7,
      multiple: 64,
    });
    const { inputs } = preparedSequenceMediaFixture("t2va", "fl2va");
    const control = await resolveMaterializeRoute(
      { nodes: [], links: [] },
      { ...inputs, duration_milliseconds: 10000 },
      {
        signal: undefined,
        artifactScope: undefined,
        preparedCanonicalPrompt: undefined,
        loadTemplate: load,
        readNodeDefinitions: () => undefined,
        nodeDefinitionReadinessReached: () => false,
        admitted: { status: "admitted" },
      },
    );
    const preservedTypes = ["VAELoader", "BasicGuider", "SaveVideo"];
    expect(
      nodes(graph)
        .filter((node) => preservedTypes.includes(String(node.type)))
        .map((node) => [node.id, node.widgets_values]),
    ).toEqual(
      nodes(control.candidateWorkflow as Json)
        .filter((node) => preservedTypes.includes(String(node.type)))
        .map((node) => [node.id, node.widgets_values]),
    );
    // Compare every other serialized node, including sampler/model, media, duration and sink.
    expect(
      nodes(graph).filter((node) => node.type !== "ResolutionSelector"),
    ).toEqual(
      nodes(control.candidateWorkflow as Json).filter(
        (node) => node.type !== "ResolutionSelector",
      ),
    );
  });

  it("keeps the single-child FL2VA template", async () => {
    expect(seam(await resolve("fl2va", "fl2va"))).toEqual(square);
  });

  it("standalone T2VA performs no parent lookup and retains its complete workflow", async () => {
    const load = vi.fn(async (name: string) => template(name));
    const options = {
      signal: undefined,
      artifactScope: undefined,
      preparedCanonicalPrompt: undefined,
      loadTemplate: load,
      readNodeDefinitions: () => undefined,
      nodeDefinitionReadinessReached: () => false,
      admitted: { status: "admitted" as const },
    };
    const { inputs } = preparedSequenceMediaFixture("t2va", "fl2va");
    const graph = (
      await resolveMaterializeRoute({ nodes: [], links: [] }, inputs, options)
    ).candidateWorkflow as Json;
    expect(seam(graph)).toEqual(wide);
    expect(load.mock.calls).toEqual([["video_minimax_h3_t2v"]]);
  });

  it.each(["absent", "split", "invalid", "conflicting", "load"])(
    "refuses an authority with %s geometry before returning any candidate",
    async (kind) => {
      const authority = template("video_minimax_h3_i2v");
      const selector = nodes(authority).find(
        (node) => node.type === "ResolutionSelector",
      )!;
      if (kind === "absent") selector.type = "PrimitiveInt";
      if (kind === "split")
        (authority.links as unknown[][])[
          (authority.links as unknown[][]).findIndex((edge) => edge[0] === 25)
        ]![1] = 99;
      if (kind === "invalid")
        selector.widgets_values = ["1:1 (Square)", -1, 32];
      if (kind === "conflicting")
        (selector.widgets_values_named as Json).multiple = 64;
      const load = vi.fn(async (name: string) => {
        if (name.endsWith("i2v") && kind === "load")
          throw new Error("synthetic template unavailable");
        return name.endsWith("i2v") ? authority : template(name);
      });
      await expect(resolve("t2va", "fl2va", 10, load)).rejects.toMatchObject({
        code: "incompatible_seam",
      });
    },
  );

  it.each(["authority", "child"] as const)(
    "refuses malformed positional or named selectors in the %s",
    async (side) => {
      const defects: ((node: Json) => void)[] = [
        (node) => {
          node.widgets_values = ["1:1 (Square)", 0.4];
        },
        (node) => {
          node.widgets_values = ["", 0.4, 32];
        },
        (node) => {
          node.widgets_values = ["1:1 (Square)", "0.4", 32];
        },
        (node) => {
          node.widgets_values = ["1:1 (Square)", 0.4, 0];
        },
        (node) => {
          node.widgets_values_named = null;
        },
        (node) => {
          node.widgets_values_named = { aspect_ratio: "1:1 (Square)" };
        },
        (node) => {
          node.widgets_values_named = {
            aspect_ratio: "1:1 (Square)",
            megapixels: 0.4,
            multiple: 64,
          };
        },
        (node) => {
          node.type = "PrimitiveInt";
        },
        (node) => {
          (node.outputs as Json[])[1]!.links = [];
        },
        (node) => {
          (node.inputs as Json[])[0]!.link = 99;
        },
      ];
      for (const mutate of defects) {
        const authority = template("video_minimax_h3_i2v");
        const child = template("video_minimax_h3_t2v");
        mutate(
          nodes(side === "authority" ? authority : child).find(
            (node) => node.type === "ResolutionSelector",
          )!,
        );
        const load = vi.fn(async (name: string) =>
          name.endsWith("i2v") ? authority : child,
        );
        await expect(resolve("t2va", "fl2va", 10, load)).rejects.toMatchObject({
          code: "incompatible_seam",
        });
      }
    },
  );
});
