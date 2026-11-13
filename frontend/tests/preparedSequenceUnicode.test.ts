import { describe, expect, it, vi } from "vitest";
import {
  validateInputs,
  validatePreparedCanonicalStart,
  validatePreparedMaterializationInputs,
  type ProductionCanonicalLowering,
} from "../src/host/appModeContract";
import { preparedSequenceMediaFixture } from "./support/preparedSequenceMediaFixture";

function fixture(
  task: "t2va" | "i2va" | "l2va" | "fl2va",
  global: "i2va" | "l2va" | "fl2va",
  prompt: string,
) {
  const { inputs, prepared } = preparedSequenceMediaFixture(
    task,
    global,
    false,
  );
  inputs.user_intent = prompt;
  const base = {
    canonicalPrompt: prompt,
    baseReportFingerprint: "sha256:" + "a".repeat(64),
    baseReportRevision: 0,
    overrideRevision: 1,
    reason: "Materialize approved Production segment prompt" as const,
  };
  const canonical: ProductionCanonicalLowering =
    task === "t2va"
      ? { ...base, schema: "h3.context.production_canonical_lowering.v1" }
      : {
          ...base,
          schema: "h3.context.production_canonical_lowering.v2",
          taskMode: task,
          bindingRoles:
            task === "fl2va"
              ? ["first_frame", "last_frame"]
              : [task === "i2va" ? "first_frame" : "last_frame"],
        };
  return {
    inputs,
    options: {
      preparedCanonicalPrompt: canonical,
      preparedSequenceMedia: prepared,
      prepareManaged: vi.fn(),
      replaceExisting: true,
    },
  };
}

describe("private canonical Unicode authority", () => {
  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["l2va", "l2va"],
    ["fl2va", "fl2va"],
    ["t2va", "fl2va"],
  ] as const)(
    "admits 4096 astral code points at private Start for %s of %s",
    (task, global) => {
      const { inputs, options } = fixture(task, global, "🌟".repeat(4096));
      expect(() =>
        validatePreparedCanonicalStart(inputs, options),
      ).not.toThrow();
      expect(() =>
        validatePreparedMaterializationInputs(inputs, options),
      ).not.toThrow();
    },
  );
  it.each([
    "🌟".repeat(4097),
    "synthetic\ud800prompt",
    "synthetic\udc00prompt",
  ])("refuses oversized or unpaired private Unicode prompt %#", (prompt) => {
    const { inputs, options } = fixture("i2va", "i2va", prompt);
    expect(() => validatePreparedCanonicalStart(inputs, options)).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(() =>
      validatePreparedMaterializationInputs(inputs, options),
    ).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });
  it("keeps the exact ordinary single-clip refusal and requires managed ownership before private counting", () => {
    const { inputs, options } = fixture("i2va", "i2va", "🌟".repeat(4096));
    expect(() => validateInputs(inputs)).toThrow(
      "invalid_request: intent must be non-empty and at most 4096 characters",
    );
    expect(() =>
      validatePreparedCanonicalStart(inputs, {
        ...options,
        prepareManaged: undefined,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() =>
      validatePreparedCanonicalStart(inputs, {
        ...options,
        preparedSequenceMedia: undefined,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });
});
