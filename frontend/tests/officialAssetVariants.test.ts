import { describe, expect, it } from "vitest";
import rawManifest from "../../comfyui_h3_context/contracts/official_h3_assets_v2.json" with { type: "json" };
import {
  OFFICIAL_ASSET_MANIFEST,
  parseOfficialAssetManifest,
  resolveOfficialAssets,
  type MaterializationAssetRole,
} from "../src/host/officialAssetResolution";

type Json = Record<string, unknown>;
const videoFp16 = "minimax_h3_video_vae_fp16.safetensors";
const videoInt8 = "minimax_h3_video_vae_int8_convrot.safetensors";
const audioFp32 = "minimax_h3_audio_vae_fp32.safetensors";
const families = [
  ["t2v", "image_to_video"],
  ["i2v", "image_to_video"],
  ["r2v", "reference_to_video"],
] as const;

// Synthetic promoted COMBO inputs reproduce the served loader structure;
// defaults are independent of the manifest so a changed official value is tested.
function nestedVaeTemplate(family: string, videoDefault: string): Json {
  const roles = [
    { role: "video_vae", value: videoDefault },
    { role: "audio_vae", value: audioFp32 },
  ];
  const type = `synthetic-${family}`;
  return {
    nodes: [
      {
        id: 1,
        type,
        widgets_values: roles.map((role) => role.value),
        widgets_values_named: Object.fromEntries(
          roles.map((role) => [role.role, role.value]),
        ),
      },
    ],
    links: [],
    definitions: {
      subgraphs: [
        {
          id: type,
          inputs: roles.map((role, index) => ({
            id: `input-${index}`,
            name: role.role,
            type: "COMBO",
          })),
          nodes: roles.map((role, index) => ({
            id: 11 + index,
            type: "VAELoader",
            inputs: [{ name: "vae_name", type: "COMBO", link: 101 + index }],
            widgets_values: [role.value],
            widgets_values_named: { vae_name: role.value },
          })),
          links: roles.map((_role, index) => ({
            id: 101 + index,
            origin_id: -10,
            origin_slot: index,
            target_id: 11 + index,
            target_slot: 0,
            type: "COMBO",
          })),
        },
      ],
    },
  };
}

describe("served official default changes", () => {
  it.each(families)(
    "binds the installed video precision for %s nested loaders",
    (name, family) => {
      const template = nestedVaeTemplate(name, videoInt8);
      const before = structuredClone(template);
      const result = resolveOfficialAssets(template, family, {
        vae: [videoFp16, audioFp32],
      });
      expect(
        result.bindings.find((binding) => binding.slot === "video_vae")?.value,
      ).toBe(videoFp16);
      expect(
        result.bindings.find((binding) => binding.slot === "audio_vae")?.value,
      ).toBe(audioFp32);
      expect(result.unresolvedSlots).not.toContain("video_vae");
      expect(template).toEqual(before);
    },
  );
  for (const [name, family] of families) {
    it.each([
      ["int8 alone", [videoInt8, audioFp32], videoInt8],
      ["both video variants", [videoFp16, videoInt8, audioFp32], videoInt8],
      ["neither video variant", [audioFp32], undefined],
    ] as const)(
      `preserves observed video preference for ${name}: %s`,
      (_label, installed, expected) => {
        const template = nestedVaeTemplate(name, videoInt8);
        const result = resolveOfficialAssets(template, family, {
          vae: installed,
        });
        expect(
          result.bindings.find((binding) => binding.slot === "video_vae")
            ?.value,
        ).toBe(expected);
        expect(
          result.bindings.find((binding) => binding.slot === "audio_vae")
            ?.value,
        ).toBe(audioFp32);
        expect(result.unresolvedSlots.includes("video_vae")).toBe(
          expected === undefined,
        );
        if (expected === undefined) expect(result.workflow).toEqual(template);
      },
    );
  }
});

// Public official names are intentionally independent of manifest defaults.
const roleVariants = [
  [
    "video_unet",
    "minimax_h3_fl2va_bf16.safetensors",
    "minimax_h3_fl2va_int8_convrot.safetensors",
    "minimax_h3_fl2va_pruned_bf16.safetensors",
    "minimax_h3_fl2va_pruned_fp8_scaled.safetensors",
    "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "minimax_h3_fl2va_pruned_w6a8.safetensors",
  ],
  [
    "reference_unet",
    "minimax_h3_ref2va_bf16.safetensors",
    "minimax_h3_ref2va_int8_convrot.safetensors",
    "minimax_h3_ref2va_pruned_bf16.safetensors",
    "minimax_h3_ref2va_pruned_fp8_scaled.safetensors",
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "minimax_h3_ref2va_pruned_w6a8.safetensors",
  ],
  [
    "text_encoder",
    "qwen3vl_32b_minimax_h3_bf16.safetensors",
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
  ],
  ["video_vae", videoFp16, videoInt8],
  ["audio_vae", audioFp32],
  [
    "image_turbo_lora",
    "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
  ],
  [
    "reference_turbo_lora",
    "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
  ],
] as const;
const shapes = ["direct", "nested"] as const;
type Shape = (typeof shapes)[number];

function roleSpec(slot: MaterializationAssetRole) {
  return OFFICIAL_ASSET_MANIFEST.slots.find((spec) => spec.slot === slot)!;
}

function roleTemplate(
  slot: MaterializationAssetRole,
  observed: string,
  shape: Shape,
): Json {
  const spec = roleSpec(slot);
  const inner = {
    id: 11,
    type: spec.loaderType,
    inputs: [{ name: spec.widgetName, type: "COMBO", link: 101 }],
    widgets_values: [observed],
    widgets_values_named: { [spec.widgetName]: observed },
  };
  if (shape === "direct")
    return { nodes: [inner], links: [], definitions: { subgraphs: [] } };
  return {
    nodes: [
      {
        id: 1,
        type: "synthetic-role",
        widgets_values: [observed],
        widgets_values_named: { promoted: observed },
      },
    ],
    links: [],
    definitions: {
      subgraphs: [
        {
          id: "synthetic-role",
          inputs: [{ id: "input-1", name: "promoted", type: "COMBO" }],
          nodes: [inner],
          links: [
            {
              id: 101,
              origin_id: -10,
              origin_slot: 0,
              target_id: 11,
              target_slot: 0,
              type: "COMBO",
            },
          ],
        },
      ],
    },
  };
}

function resolveRole(
  slot: MaterializationAssetRole,
  observed: string,
  shape: Shape,
  installed: readonly string[],
) {
  const family =
    slot === "reference_unet" || slot === "reference_turbo_lora"
      ? "reference_to_video"
      : "image_to_video";
  const template = roleTemplate(slot, observed, shape);
  const before = structuredClone(template);
  const result = resolveOfficialAssets(template, family, {
    [roleSpec(slot).folderCategory]: installed,
  });
  expect(template).toEqual(before);
  return result;
}

describe.each(shapes)(
  "%s role lookup with independently observed defaults",
  (shape) => {
    for (const [slot, ...variants] of roleVariants) {
      for (const observed of variants) {
        it(`${slot} prefers observed ${observed} when all variants are installed`, () => {
          const result = resolveRole(
            slot,
            observed,
            shape,
            [...variants].reverse(),
          );
          expect(
            result.bindings.find((binding) => binding.slot === slot)?.value,
          ).toBe(observed);
          expect(
            result.selections.find((selection) => selection.slot === slot)
              ?.reason,
          ).toBe("template_default");
          expect(result.unresolvedSlots).not.toContain(slot);
          expect(result.changedSlots).not.toContain(slot);
        });
        it(`${slot} binds its only installed observed ${observed}`, () => {
          const result = resolveRole(slot, observed, shape, [observed]);
          expect(
            result.bindings.find((binding) => binding.slot === slot)?.value,
          ).toBe(observed);
        });
        it(`${slot} keeps observed ${observed} advisory when no official variant is installed`, () => {
          const result = resolveRole(slot, observed, shape, []);
          expect(result.unresolvedSlots).toContain(slot);
          expect(
            result.bindings.find((binding) => binding.slot === slot),
          ).toBeUndefined();
          expect(result.workflow).toEqual(roleTemplate(slot, observed, shape));
        });
        for (const alternative of variants.filter(
          (value) => value !== observed,
        )) {
          it(`${slot} falls back from ${observed} to installed ${alternative}`, () => {
            const result = resolveRole(slot, observed, shape, [alternative]);
            expect(
              result.bindings.find((binding) => binding.slot === slot)?.value,
            ).toBe(alternative);
            expect(result.changedSlots).toContain(slot);
            const owner = (result.workflow.nodes as Json[])[0]!;
            expect(owner.widgets_values).toEqual([alternative]);
            expect(Object.values(owner.widgets_values_named as Json)).toEqual([
              alternative,
            ]);
            if (shape === "nested") {
              expect(result.workflow.definitions).toEqual(
                roleTemplate(slot, observed, shape).definitions,
              );
            }
          });
        }
      }
    }

    it.each(["video_vae", "audio_vae"] as const)(
      "never substitutes the other VAE role for %s",
      (slot) => {
        const observed = slot === "video_vae" ? videoInt8 : audioFp32;
        const other = slot === "video_vae" ? audioFp32 : videoFp16;
        const result = resolveRole(slot, observed, shape, [other]);
        expect(result.unresolvedSlots).toContain(slot);
        expect(result.bindings).toEqual([]);
        expect(result.workflow).toEqual(roleTemplate(slot, observed, shape));
      },
    );

    it("preserves the exact installed relocated observed value over manifest preferences", () => {
      const observed = videoInt8;
      const installed = `official/${videoInt8}`;
      const result = resolveRole("video_vae", observed, shape, [
        videoFp16,
        installed,
      ]);
      expect(
        result.bindings.find((binding) => binding.slot === "video_vae")?.value,
      ).toBe(installed);
      expect(
        result.selections.find((selection) => selection.slot === "video_vae")
          ?.reason,
      ).toBe("relocated_default");
    });
    it("locates changed official defaults without named-widget metadata", () => {
      const template = roleTemplate("video_vae", videoInt8, shape);
      delete (template.nodes as Json[])[0]!.widgets_values_named;
      if (shape === "nested") {
        const definition = (
          (template.definitions as Json).subgraphs as Json[]
        )[0]!;
        delete (definition.nodes as Json[])[0]!.widgets_values_named;
      }
      const result = resolveOfficialAssets(template, "image_to_video", {
        vae: [videoFp16],
      });
      expect(
        result.bindings.find((binding) => binding.slot === "video_vae")?.value,
      ).toBe(videoFp16);
    });
  },
);

describe("shared loader role isolation", () => {
  it("rejects case-folded duplicate accepted names within a role", () => {
    const candidate = structuredClone(rawManifest);
    candidate.slots[0]!.accepted_basenames.push(
      candidate.slots[0]!.template_default.toUpperCase(),
    );
    expect(() => parseOfficialAssetManifest(candidate)).toThrowError(
      expect.objectContaining({ code: "invalid_manifest" }),
    );
  });
  it.each([
    ["video_vae", "audio_vae"],
    ["video_unet", "reference_unet"],
    ["image_turbo_lora", "reference_turbo_lora"],
  ] as const)("rejects intersecting names for %s and %s", (first, second) => {
    for (const upperCase of [false, true]) {
      const candidate = structuredClone(rawManifest);
      const firstSpec = candidate.slots.find((spec) => spec.slot === first)!;
      const secondSpec = candidate.slots.find((spec) => spec.slot === second)!;
      secondSpec.accepted_basenames.push(
        upperCase
          ? firstSpec.template_default.toUpperCase()
          : firstSpec.template_default,
      );
      expect(() => parseOfficialAssetManifest(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_manifest" }),
      );
    }
  });
});
