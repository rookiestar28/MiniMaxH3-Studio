import { describe, expect, it } from "vitest";
import {
  assertCropWeightSampleGeometry as checkGeometry,
  type CropWeightPrompt,
} from "./support/cropWeightSampleGeometry";

function assertCropWeightSampleGeometry(
  mode: "ref2va" | "fl2va",
  prompt: CropWeightPrompt,
  count: number,
) {
  checkGeometry(mode, prompt, count, "synthetic.png");
}

function geometry(mode: "ref2va" | "fl2va"): CropWeightPrompt {
  const prompt: CropWeightPrompt = {
    selector: { class_type: "ResolutionSelector", inputs: { megapixels: 0.2 } },
    generator: {
      class_type:
        mode === "fl2va"
          ? "MiniMaxH3ImageToVideo"
          : "MiniMaxH3ReferenceToVideo",
      inputs: {
        first_frame: ["crop", 0],
        width: ["selector", 0],
        height: ["selector", 1],
      },
    },
  };
  if (mode === "fl2va") {
    prompt.crop = {
      class_type: "ImageCropV2",
      inputs: { image: ["loader", 0] },
    };
    prompt.loader = {
      class_type: "LoadImage",
      inputs: { image: "synthetic.png" },
    };
    prompt.scale = {
      class_type: "ImageScaleToTotalPixels",
      inputs: { image: ["crop", 0], megapixels: 0.2 },
    };
    prompt.size = {
      class_type: "GetImageSize",
      inputs: { image: ["scale", 0] },
    };
  }
  return prompt;
}

function configuredWidgets(prompt: CropWeightPrompt): number {
  return Object.values(prompt).filter((node) =>
    Object.hasOwn(node.inputs, "megapixels"),
  ).length;
}

describe("crop weight sample geometry admission", () => {
  it("admits Ref2VA's single output selector", () => {
    const prompt = geometry("ref2va");
    expect(() =>
      assertCropWeightSampleGeometry(
        "ref2va",
        prompt,
        configuredWidgets(prompt),
      ),
    ).not.toThrow();
  });

  it("admits native-observed FL2VA selector geometry alongside the unused scaler", () => {
    const prompt = geometry("fl2va");
    expect(configuredWidgets(prompt)).toBe(2);
    expect(() =>
      assertCropWeightSampleGeometry(
        "fl2va",
        prompt,
        configuredWidgets(prompt),
      ),
    ).not.toThrow();
  });

  it.each([
    ["ref2va", 0],
    ["ref2va", 2],
    ["fl2va", 1],
    ["fl2va", 3],
  ] as const)("rejects %s with %i selected widgets", (mode, count) => {
    expect(() =>
      assertCropWeightSampleGeometry(mode, geometry(mode), count),
    ).toThrow();
  });

  it.each(["ref2va", "fl2va"] as const)(
    "requires one bounded selector in %s",
    (mode) => {
      const prompt = geometry(mode);
      prompt.selector!.inputs.megapixels = 0.8;
      expect(() =>
        assertCropWeightSampleGeometry(mode, prompt, mode === "fl2va" ? 2 : 1),
      ).toThrow();
      delete prompt.selector;
      expect(() =>
        assertCropWeightSampleGeometry(mode, prompt, mode === "fl2va" ? 2 : 1),
      ).toThrow();
    },
  );

  it("does not mistake the unused scaler for FL2VA output geometry", () => {
    const prompt = geometry("fl2va");
    prompt.scale!.inputs.megapixels = 0.8;
    expect(() =>
      assertCropWeightSampleGeometry("fl2va", prompt, 2),
    ).not.toThrow();
  });

  it.each(["bypass", "missing", "wrong-slot"])(
    "rejects a %s first-frame crop source",
    (variant) => {
      const prompt = geometry("fl2va");
      if (variant === "bypass")
        prompt.generator!.inputs.first_frame = ["loader", 0];
      if (variant === "missing")
        prompt.generator!.inputs.first_frame = ["missing", 0];
      if (variant === "wrong-slot")
        prompt.generator!.inputs.first_frame = ["crop", 1];
      expect(() => assertCropWeightSampleGeometry("fl2va", prompt, 2)).toThrow(
        /cropped first frame/,
      );
    },
  );

  it.each([
    ["width", ["size", 0]],
    ["height", ["size", 1]],
    ["width", ["selector", 1]],
    ["height", ["selector", 0]],
    ["width", 512],
    ["width", ["missing", 0]],
    ["width", ["size", 0, 1]],
  ])("rejects disconnected or malformed %s geometry", (input, value) => {
    const prompt = geometry("fl2va");
    prompt.generator!.inputs[input as string] = value;
    expect(() => assertCropWeightSampleGeometry("fl2va", prompt, 2)).toThrow();
  });

  it.each([
    { value: ["selector", 0] },
    { value: ["loader", 1] },
    { value: ["missing", 0] },
    { value: 512 },
  ])(
    "rejects a non-loader or malformed cropped image input $value",
    ({ value }) => {
      const prompt = geometry("fl2va");
      prompt.crop!.inputs.image = value;
      expect(() =>
        assertCropWeightSampleGeometry("fl2va", prompt, 2),
      ).toThrow();
    },
  );

  it.each(["generator", "selector", "crop", "loader"])(
    "rejects the wrong %s node class",
    (id) => {
      const prompt = geometry("fl2va");
      prompt[id]!.class_type = "UnrelatedNode";
      expect(() =>
        assertCropWeightSampleGeometry("fl2va", prompt, 2),
      ).toThrow();
    },
  );

  it("rejects ambiguous generators", () => {
    const prompt = geometry("fl2va");
    prompt.extra = structuredClone(prompt.generator!);
    expect(() => assertCropWeightSampleGeometry("fl2va", prompt, 2)).toThrow();
  });

  it("retains only bounded shape facts for unknown compiled geometry", () => {
    const prompt = geometry("fl2va");
    prompt.selector!.class_type = "private-class-must-not-appear";
    prompt.selector!.inputs.image = [
      "private-node-id-must-not-appear",
      7,
      "private-value",
    ];
    let message = "";
    try {
      assertCropWeightSampleGeometry("fl2va", prompt, 2);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('"Other"');
    expect(message).not.toMatch(/private-class|private-node-id|private-value/);
    const facts = JSON.parse(message.split("\n")[0]!);
    expect(facts.hops).toHaveLength(2);
    expect(facts.hops[0][0]).toBe(true);
    expect(facts.hops[0][4][1]).toBe(3);
    expect(facts.hops[1][0]).toBe(false);
  });

  it("reports all three known hops without ids and preserves colon evidence", () => {
    const prompt = geometry("fl2va");
    prompt["private:size"] = prompt.size!;
    delete prompt.size;
    prompt.generator!.inputs.width = ["private:size", 0];
    prompt.generator!.inputs.height = ["private:size", 1];
    prompt.crop = {
      class_type: "ImageCropV2",
      inputs: { image: ["private:loader", 0] },
    };
    prompt.scale!.inputs.megapixels = 0.8;
    let message = "";
    try {
      assertCropWeightSampleGeometry("fl2va", prompt, 2);
    } catch (error) {
      message = (error as Error).message;
    }
    const facts = JSON.parse(message.split("\n")[0]!);
    expect(facts.w[3]).toBe(true);
    expect(facts.hops.map((hop: unknown[]) => hop[1])).toEqual([
      "GetImageSize",
      "ImageScaleToTotalPixels",
      "ImageCropV2",
    ]);
    expect(facts.hops[1][2]).toBe(0.8);
    expect(message.split("\n")[0]!.length).toBeLessThan(380);
    expect(message).not.toMatch(/private:size|private:loader/);
  });

  it("refuses a crop from a different chosen file without disclosing its value", () => {
    const prompt = geometry("fl2va");
    prompt.loader!.inputs.image = "private-source-must-not-appear.png";
    let message = "";
    try {
      assertCropWeightSampleGeometry("fl2va", prompt, 2);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/chosen LoadImage/);
    const facts = JSON.parse(message.split("\n")[0]!);
    expect(facts.f).toEqual(["array", 2, 0, false, "string"]);
    expect(facts.hops.map((hop: unknown[]) => hop[1])).toEqual([
      "ImageCropV2",
      "LoadImage",
      "Other",
    ]);
    expect(message.split("\n")[0]!.length).toBeLessThan(380);
    expect(message).not.toContain("private-source");
  });

  it("refuses multiple selectors instead of choosing an arbitrary bound", () => {
    const prompt = geometry("fl2va");
    prompt.extraSelector = structuredClone(prompt.selector!);
    expect(() => assertCropWeightSampleGeometry("fl2va", prompt, 2)).toThrow();
  });
});
