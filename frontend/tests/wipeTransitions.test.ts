import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/m25_10_composition_contract_v1.json";
import {
  WIPE_KINDS,
  decodePublicCompositionSnapshot,
  decodeResolvedScene,
  publicCompositionFingerprint,
} from "../src/contracts/compositionCodec";
import { resolveCompositionScene } from "../src/runtime/sceneResolver";
import { wipeRevealRect } from "../src/runtime/visualCompositor";

const wipeKinds = [
  "wipe_from_left_v1",
  "wipe_from_right_v1",
  "wipe_from_top_v1",
  "wipe_from_bottom_v1",
] as const;

function wipeScene(
  kind: (typeof wipeKinds)[number] = "wipe_from_left_v1",
  elapsed = 0,
) {
  const wire = structuredClone(fixture.snapshot);
  const incoming = wire.clips[1]!;
  incoming.transition = { kind, duration_frames: 6 };
  wire.public_fingerprint = publicCompositionFingerprint(wire);
  return resolveCompositionScene(
    decodePublicCompositionSnapshot(wire),
    incoming.start_frame + elapsed,
  );
}

describe("layer-local directional wipes", () => {
  it("pins all four wire kinds independently of the exported enumeration", () => {
    expect(WIPE_KINDS).toEqual(wipeKinds);
  });

  it.each([
    ["wipe_from_left_v1", 0, { x: 0, y: 0, width: 0, height: 48 }],
    ["wipe_from_left_v1", 2, { x: 0, y: 0, width: 21, height: 48 }],
    ["wipe_from_left_v1", 5, { x: 0, y: 0, width: 53, height: 48 }],
    ["wipe_from_left_v1", 6, { x: 0, y: 0, width: 64, height: 48 }],
    ["wipe_from_right_v1", 2, { x: 43, y: 0, width: 21, height: 48 }],
    ["wipe_from_top_v1", 2, { x: 0, y: 0, width: 64, height: 16 }],
    ["wipe_from_bottom_v1", 2, { x: 0, y: 32, width: 64, height: 16 }],
  ] as const)("quantizes %s at frame %i", (kind, elapsed, expected) => {
    expect(wipeRevealRect(kind, 64, 48, elapsed, 6)).toEqual(expected);
  });

  it.each([
    ["width", 0, 48, 2, 6],
    ["width", -1, 48, 2, 6],
    ["width", 1.5, 48, 2, 6],
    ["width", 1_000_001, 48, 2, 6],
    ["height", 64, 0, 2, 6],
    ["height", 64, -1, 2, 6],
    ["height", 64, 1.5, 2, 6],
    ["height", 64, 1_000_001, 2, 6],
    ["elapsed", 64, 48, -1, 6],
    ["elapsed", 64, 48, 301, 6],
    ["elapsed", 64, 48, 1.5, 6],
    ["duration", 64, 48, 2, 0],
    ["duration", 64, 48, 2, 301],
    ["duration", 64, 48, 2, 1.5],
  ] as const)(
    "refuses an out-of-range reveal %s (%i,%i,%i,%i)",
    (_name, width, height, elapsed, duration) => {
      expect(() =>
        wipeRevealRect("wipe_from_left_v1", width, height, elapsed, duration),
      ).toThrow("invalid_contract");
    },
  );

  it.each(wipeKinds)("clamps %s beyond its reveal duration", (kind) => {
    expect(wipeRevealRect(kind, 64, 48, 7, 6)).toEqual({
      x: 0,
      y: 0,
      width: 64,
      height: 48,
    });
  });

  it("keeps the public reveal rectangle immutable", () => {
    const rectangle = wipeRevealRect("wipe_from_left_v1", 64, 48, 2, 6);
    expect(Object.isFrozen(rectangle)).toBe(true);
    expect(Reflect.set(rectangle, "width", 64)).toBe(false);
    expect(rectangle.width).toBe(21);
  });

  it.each(wipeKinds)(
    "resolves and decodes %s across its exact window",
    (kind) => {
      const wire = structuredClone(fixture.snapshot);
      const incoming = wire.clips[1]!;
      incoming.transition = { kind, duration_frames: 6 };
      wire.public_fingerprint = publicCompositionFingerprint(wire);
      const snapshot = decodePublicCompositionSnapshot(wire);
      for (const elapsed of [0, 2, 5, 6, 11]) {
        const scene = resolveCompositionScene(
          snapshot,
          incoming.start_frame + elapsed,
        );
        const decoded = decodeResolvedScene(scene);
        const layer = decoded.layers.find(
          (row) => row.clipId === incoming.clip_id,
        )!;
        expect(layer.wipe).toEqual({ kind, durationFrames: 6 });
        expect(layer.transitionElapsedFrames).toBe(
          elapsed < 6 ? elapsed : null,
        );
        expect((layer.operationIds as string[]).includes("WipeV1")).toBe(
          elapsed < 6,
        );
        expect(
          (layer.operationIds as string[]).includes("CrossDissolveV1"),
        ).toBe(false);
      }
      const forged = structuredClone(
        resolveCompositionScene(snapshot, incoming.start_frame),
      );
      const row = forged.layers.find(
        (layer) => layer.clip_id === incoming.clip_id,
      )!;
      (row as Record<string, unknown>).wipe = {
        kind: "wipe_unknown_v1",
        duration_frames: 6,
      };
      expect(() => decodeResolvedScene(forged)).toThrow("invalid_contract");
    },
  );

  it.each([
    ["none", 1],
    ...["cross_dissolve_v1", ...wipeKinds].flatMap((kind) => [
      [kind, 0],
      [kind, 13],
    ]),
  ])("refuses snapshot transition %s with duration %i", (kind, duration) => {
    const wire = structuredClone(fixture.snapshot);
    wire.clips[1]!.transition = {
      kind: kind as string,
      duration_frames: duration as number,
    };
    wire.public_fingerprint = publicCompositionFingerprint(wire);
    expect(() => decodePublicCompositionSnapshot(wire)).toThrow(
      /invalid_contract: .*transition duration is invalid/,
    );
  });

  it.each(wipeKinds)("orders %s before drawing the title", (kind) => {
    const wire = structuredClone(fixture.snapshot);
    const title = wire.clips[3]!;
    title.transition = { kind, duration_frames: 6 };
    wire.public_fingerprint = publicCompositionFingerprint(wire);
    const scene = resolveCompositionScene(
      decodePublicCompositionSnapshot(wire),
      title.start_frame + 2,
    );
    const decoded = decodeResolvedScene(scene);
    const layer = decoded.layers.find((row) => row.clipId === title.clip_id)!;
    expect(layer.operationIds).toEqual([
      "SelectSourceRangeV1",
      "CropV1",
      "Transform2DV1",
      "OpacityV1",
      "BlendV1",
      "WipeV1",
      "DrawTextV1",
    ]);
    expect(layer.wipe).toEqual({ kind, durationFrames: 6 });
    expect(layer.transitionElapsedFrames).toBe(2);
  });

  it.each([
    { label: "null", value: null },
    { label: "numeric", value: 0 },
    { label: "string", value: "layer" },
    { label: "boolean", value: true },
    { label: "undefined", value: undefined },
    { label: "array", value: [] },
  ])(
    "refuses a $label resolved layer with a typed contract error",
    ({ value }) => {
      expect(() =>
        decodeResolvedScene({ ...wipeScene(), layers: [value] }),
      ).toThrow("invalid_contract");
    },
  );

  it.each(["schema", "profile_id"] as const)(
    "refuses unsupported %s before decoding malformed layers",
    (field) => {
      expect(() =>
        decodeResolvedScene({
          ...wipeScene(),
          layers: [null],
          [field]: "unsupported",
        }),
      ).toThrow("unsupported_profile");
    },
  );

  it.each(wipeKinds)(
    "refuses invalid %s descriptor durations outside the active window",
    (kind) => {
      for (const duration of [0, -1, 301, 1.5, true]) {
        const scene = wipeScene(kind, 6);
        const layer = scene.layers.find(
          (row) => row.clip_id === fixture.snapshot.clips[1]!.clip_id,
        )!;
        (layer as Record<string, unknown>).wipe = {
          kind,
          duration_frames: duration,
        };
        expect(() => decodeResolvedScene(scene)).toThrow("invalid_contract");
      }
    },
  );

  it.each(wipeKinds)(
    "refuses active %s elapsed at or past its duration",
    (kind) => {
      for (const elapsed of [6, 7]) {
        const scene = wipeScene(kind);
        const layer = scene.layers.find(
          (row) => row.clip_id === fixture.snapshot.clips[1]!.clip_id,
        )!;
        (layer as Record<string, unknown>).transition_elapsed_frames = elapsed;
        expect(() => decodeResolvedScene(scene)).toThrow("invalid_contract");
      }
    },
  );

  it.each([0, 2, 3, 4, 11])(
    "preserves the old cross-dissolve handoff at elapsed %i",
    (elapsed) => {
      const snapshot = decodePublicCompositionSnapshot(
        structuredClone(fixture.snapshot),
      );
      const incoming = fixture.snapshot.clips[1]!;
      const scene = resolveCompositionScene(
        snapshot,
        incoming.start_frame + elapsed,
      );
      const decoded = decodeResolvedScene(scene);
      const layer = decoded.layers.find(
        (row) => row.clipId === incoming.clip_id,
      )!;
      expect(layer.transitionElapsedFrames).toBe(elapsed < 4 ? elapsed : null);
      expect(layer.operationIds).toEqual([
        "SelectSourceRangeV1",
        "CropV1",
        "Transform2DV1",
        "ColorAdjustV1",
        "OpacityV1",
        "BlendV1",
        ...(elapsed < 4 ? ["CrossDissolveV1"] : []),
      ]);
      for (const row of [...scene.layers, ...decoded.layers])
        expect(row).not.toHaveProperty("wipe");
    },
  );

  it("keeps decoded layer vector immutable", () => {
    const decoded = decodeResolvedScene(wipeScene());
    expect(Object.isFrozen(decoded.layers)).toBe(true);
    expect(Reflect.set(decoded.layers, "length", 0)).toBe(false);
    expect(decoded.layers.length).toBeGreaterThan(0);
  });

  it("keeps decoded wipe metadata immutable", () => {
    const decoded = decodeResolvedScene(wipeScene());
    const layer = decoded.layers.find(
      (row) => row.clipId === fixture.snapshot.clips[1]!.clip_id,
    )!;
    const wipe = layer.wipe as { durationFrames: number };
    expect(Object.isFrozen(wipe)).toBe(true);
    expect(Reflect.set(wipe, "durationFrames", 0)).toBe(false);
    expect(wipe.durationFrames).toBe(6);
  });
});
