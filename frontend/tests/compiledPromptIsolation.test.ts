import { describe, expect, it } from "vitest";

import {
  buildManagedAppModePreparation,
  type AppModeInputs,
} from "../src/host/appMode";
import { createQualifiedBasePrompt } from "./support/qualifiedBasePrompt";
import { projectManagedExecutionPrompt } from "../src/host/appModeManagedPreparation";
import { fingerprint } from "../src/host/appModeContract";
import { hostCompiledPrompt } from "./support/hostCompiledPrompt";

const frameInputs: AppModeInputs = {
  task_mode: "i2va",
  user_intent: "Synthetic proxy crop isolation regression.",
  duration_milliseconds: 5_000,
  frame_count: 124,
  first_frame_source: "17",
};
const region = { x: 0, y: 0, width: 64, height: 96 };
const ownedGraph = Object.freeze({
  nodeIds: Object.freeze(["1", "8", "45"]),
  linkIds: Object.freeze(["15", "17", "18"]),
  anchorNodeId: "6",
  fingerprint: `sha256:${"b".repeat(64)}`,
});

function fixture(proxy: boolean) {
  const sourceRegion = proxy ? new Proxy({ ...region }, {}) : { ...region };
  const output = createQualifiedBasePrompt(frameInputs, {
    first_frame: {
      class_type: "LoadImage",
      inputs: { image: "synthetic/source.png" },
    },
  }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  for (const node of Object.values(output))
    for (const [name, value] of Object.entries(node.inputs))
      if (Array.isArray(value) && String(value[0]) === "9" && value[1] === 0)
        node.inputs[name] = ["60", 0];
  output["60"] = {
    class_type: "ImageCropV2",
    inputs: { image: ["9", 0], crop_region: sourceRegion },
  };
  const prepare = () =>
    buildManagedAppModePreparation(
      hostCompiledPrompt(output, {}),
      frameInputs,
      "replace",
      "sha256:" + "a".repeat(64),
      ownedGraph,
      undefined,
      undefined,
      undefined,
      {
        media_binding_fingerprint: "sha256:" + "c".repeat(64),
        source_identities: [
          {
            asset_id: "first_frame_1",
            role: "first_frame",
            receipt_handle: "ig_" + "n".repeat(40),
            source_fingerprint: "sha256:" + "d".repeat(64),
          },
        ],
      },
    );
  return { output, sourceRegion, prepare };
}

describe("native compiled prompt data isolation", () => {
  it("prepares the unchanged plain-region control", () => {
    const plain = fixture(false);
    const prepared = plain.prepare();
    expect(prepared.observation.schema).toBe(
      "h3.context.prepared_graph_observation.v5",
    );
    expect(prepared.bootstrap.output["60"]).toEqual(plain.output["60"]);
  });

  it("isolates a native proxy region without changing its plain-input identity", () => {
    const plain = fixture(false).prepare();
    const native = fixture(true);
    const prepared = native.prepare();
    expect(prepared.observation).toEqual(plain.observation);
    const crop = prepared.bootstrap.output["60"] as {
      inputs: { crop_region: typeof region };
    };
    expect(crop.inputs.crop_region).toEqual(region);
    expect(crop.inputs.crop_region).not.toBe(native.sourceRegion);
    crop.inputs.crop_region.x = 32;
    expect(native.sourceRegion.x).toBe(0);
    native.sourceRegion.y = 32;
    expect(crop.inputs.crop_region.y).toBe(0);
  });

  it("isolates a proxy source before a managed projector can mutate it", () => {
    const native = fixture(true);
    const source = hostCompiledPrompt(native.output, {});
    const before = fingerprint(source);
    let isolatedKeys: (string | symbol)[] = [];
    const projected = projectManagedExecutionPrompt(source, (isolated) => {
      isolatedKeys = Reflect.ownKeys(isolated);
      const crop = isolated.output["60"] as {
        inputs: { crop_region: typeof region };
      };
      crop.inputs.crop_region.x = 32;
      return isolated;
    });
    expect(fingerprint(source)).toBe(before);
    expect(isolatedKeys).toEqual(Reflect.ownKeys(source));
    expect(native.sourceRegion.x).toBe(0);
    expect(projected).not.toBe(source);
    expect(
      (projected.output["60"] as { inputs: { crop_region: typeof region } })
        .inputs.crop_region.x,
    ).toBe(32);
  });

  it("isolates a proxy returned by a managed projector", () => {
    const plain = fixture(false);
    const source = hostCompiledPrompt(plain.output, {});
    const projectedRegion = new Proxy({ ...region }, {});
    const projected = projectManagedExecutionPrompt(source, (isolated) => {
      const crop = isolated.output["60"] as {
        inputs: { crop_region: typeof region };
      };
      crop.inputs.crop_region = projectedRegion;
      return isolated;
    });
    expect(fingerprint(projected)).toBe(fingerprint(source));
    expect(Reflect.ownKeys(projected)).toEqual(Reflect.ownKeys(source));
    const crop = projected.output["60"] as {
      inputs: { crop_region: typeof region };
    };
    expect(crop.inputs.crop_region).not.toBe(projectedRegion);
    crop.inputs.crop_region.x = 32;
    expect(projectedRegion.x).toBe(0);
    expect(plain.sourceRegion.x).toBe(0);
  });
});
