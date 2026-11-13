import { describe, expect, it, vi } from "vitest";
import {
  validatePreparedCanonicalStart,
  type AppModeStartOptions,
  type ProductionCanonicalLowering,
} from "../src/host/appModeContract";
import { preparedSequenceMediaFixture } from "./support/preparedSequenceMediaFixture";

function fixture(
  task: "t2va" | "i2va" | "l2va" | "fl2va" = "i2va",
  global: "i2va" | "l2va" | "fl2va" = "i2va",
) {
  const { inputs, prepared } = preparedSequenceMediaFixture(task, global, true);
  const base = {
    canonicalPrompt: inputs.user_intent,
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
  const options: AppModeStartOptions & {
    preparedSequenceMedia?: typeof prepared;
  } = {
    preparedCanonicalPrompt: canonical,
    preparedSequenceMedia: prepared,
    prepareManaged: vi.fn(),
    replaceExisting: true,
  };
  return { inputs, options };
}

describe("private frame sequence Start boundary", () => {
  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["l2va", "l2va"],
    ["fl2va", "fl2va"],
    ["t2va", "fl2va"],
  ] as const)("admits the reserved child %s of %s contract", (task, global) => {
    const { inputs, options } = fixture(task, global);
    expect(() => validatePreparedCanonicalStart(inputs, options)).not.toThrow();
  });
  it.each([
    "without_canonical",
    "without_managed",
    "prepare_only",
    "adopt",
    "connect",
    "selector",
    "wrong_global",
  ])("refuses reserved media on %s before materialization", (defect) => {
    const { inputs, options } = fixture();
    if (defect === "without_canonical") delete options.preparedCanonicalPrompt;
    if (defect === "without_managed") delete options.prepareManaged;
    if (defect === "prepare_only") options.prepareOnly = true;
    if (defect === "adopt") options.useExisting = true;
    if (defect === "connect") options.connectExisting = {};
    if (defect === "selector") inputs.first_frame_source = "another.loader";
    if (defect === "wrong_global")
      options.preparedSequenceMedia = {
        ...options.preparedSequenceMedia!,
        sequenceTaskMode: "l2va",
      };
    expect(() => validatePreparedCanonicalStart(inputs, options)).toThrow();
  });
  it("requires retained media for a frame canonical Start", () => {
    const { inputs, options } = fixture();
    delete options.preparedSequenceMedia;
    expect(() => validatePreparedCanonicalStart(inputs, options)).toThrow();
  });
});
