import { describe, expect, it } from "vitest";
import {
  compiledPromptMatchesRequestedRoute,
  isCompatibleExistingPrompt,
} from "../src/host/appModeExistingRoute";
import {
  CROP_FIXTURE_REQUEST as crop,
  cropPreparedCompiledPrompt as fixture,
} from "./support/cropPreparedPrompt";
import {
  decodeComfyPromptHistory,
  decodeComfyPromptHistorySavedVideos,
} from "../src/host/comfyPromptHistory";
describe("crop interposer compiled identity", () => {
  it.each(["i2va", "fl2va", "l2va", "ref2va"] as const)(
    "accepts exactly bound %s crops only for preparation",
    (mode) => {
      const { compiled, inputs, ids } = fixture(mode);
      expect(isCompatibleExistingPrompt(compiled)).toBe(true);
      expect(
        compiledPromptMatchesRequestedRoute(
          compiled,
          inputs,
          "materialize",
          ids,
          undefined,
          undefined,
          true,
        ),
      ).toBe(true);
      expect(
        compiledPromptMatchesRequestedRoute(
          compiled,
          inputs,
          "materialize",
          ids,
        ),
      ).toBe(false);
    },
  );
  it.each([
    "region",
    "extra",
    "missing",
    "loader",
    "request",
    "registry",
    "native",
    "scale",
  ])("refuses a mutated %s binding", (mutation) => {
    const { compiled, inputs, ids, output } = fixture("i2va");
    if (mutation === "region")
      (output["60"]!.inputs.crop_region as Record<string, number>).width = 321;
    if (mutation === "extra") output["61"] = structuredClone(output["60"]!);
    if (mutation === "missing") delete output["60"];
    if (mutation === "loader") output["60"]!.inputs.image = ["60", 0];
    if (mutation === "request")
      inputs.image_crops = { "17": { ...crop, x: 9 } };
    if (mutation === "registry") output["11"]!.inputs.first_frame = ["9", 0];
    if (mutation === "native") output["6"]!.inputs.first_frame = ["9", 0];
    if (mutation === "scale") output["47"]!.inputs.image = ["9", 0];
    expect(
      compiledPromptMatchesRequestedRoute(
        compiled,
        inputs,
        "materialize",
        ids,
        undefined,
        undefined,
        true,
      ),
    ).toBe(false);
  });
  it("structurally refuses a second crop on the same loader", () => {
    const { compiled, output } = fixture("i2va");
    output["61"] = structuredClone(output["60"]!);
    expect(isCompatibleExistingPrompt(compiled)).toBe(false);
  });
  it("does not expand connect's reference-source admission", () => {
    expect(
      isCompatibleExistingPrompt(fixture("ref2va").compiled, "connect"),
    ).toBe(false);
  });
  it("attributes the saved video exactly when a crop preview appears in history", () => {
    const promptId = "crop-fixture-1";
    const history = {
      [promptId]: {
        status: {
          status_str: "success",
          completed: true,
          messages: [["execution_success", { prompt_id: promptId }]],
        },
        outputs: {
          "60": {
            images: [
              { filename: "crop-preview.png", subfolder: "", type: "temp" },
            ],
          },
          "43": {
            animated: [true],
            images: [
              { filename: "video.mp4", subfolder: "video", type: "output" },
            ],
          },
        },
      },
    };
    expect(decodeComfyPromptHistory(history, promptId)).toMatchObject({
      disposition: "succeeded",
      outputNodeIds: ["43", "60"],
    });
    const saved = decodeComfyPromptHistorySavedVideos(history, promptId);
    expect(saved.artifacts).toHaveLength(1);
    expect(saved.artifacts[0]).toMatchObject({ outputNodeId: "43" });
  });
});
