import { describe, expect, it } from "vitest";
import {
  type AppModeCompiledPrompt,
  contentFreeBootstrapWorkflow,
  fingerprint,
  normalizeAppModeCompiledPrompt,
} from "../src/host/appModeContract";
import { cloneQueueEnvelope } from "../src/host/queueSeam";
import { hostCompiledPrompt } from "./support/hostCompiledPrompt";

// A native crop region as frontend 1.57.1 hands it over: a proxy that structuredClone rejects.
const nativeRegion = () =>
  new Proxy({ x: 160, y: 96, width: 608, height: 352 }, {});

function croppedOutput(region: unknown) {
  return {
    "2": { class_type: "LoadImage", inputs: { image: "synthetic.png" } },
    "1": {
      class_type: "ImageCropV2",
      inputs: { image: ["2", 0], crop_region: region },
    },
  };
}

// The managed queue envelope as App Mode builds it: normalized, workflow replaced in place.
function managedEnvelope(
  compiled: AppModeCompiledPrompt,
): AppModeCompiledPrompt {
  return {
    ...normalizeAppModeCompiledPrompt(compiled),
    workflow: contentFreeBootstrapWorkflow(),
  } as AppModeCompiledPrompt;
}

describe("queue envelope key order", () => {
  it("keeps the validated identity through the proxy fallback in host order", () => {
    const source = managedEnvelope(
      hostCompiledPrompt(croppedOutput(nativeRegion()), {}) as never,
    );
    expect(() => structuredClone(source)).toThrow();

    const isolated = cloneQueueEnvelope(source);

    expect(isolated).toBeDefined();
    expect(Reflect.ownKeys(isolated!)).toEqual(["workflow", "output"]);
    expect(fingerprint(isolated)).toBe(fingerprint(source));
  });

  it("keeps a non-host order through the proxy fallback too", () => {
    const source = managedEnvelope({
      output: croppedOutput(nativeRegion()),
      workflow: {},
    } as never);

    const isolated = cloneQueueEnvelope(source);

    expect(isolated).toBeDefined();
    expect(Reflect.ownKeys(isolated!)).toEqual(["output", "workflow"]);
    expect(fingerprint(isolated)).toBe(fingerprint(source));
  });

  it("leaves a plain envelope in host order on the structuredClone path", () => {
    const source = managedEnvelope(
      hostCompiledPrompt(
        croppedOutput({ x: 160, y: 96, width: 608, height: 352 }),
        {},
      ) as never,
    );

    const isolated = cloneQueueEnvelope(source);

    expect(isolated).toEqual(structuredClone(source));
    expect(Reflect.ownKeys(isolated!)).toEqual(["workflow", "output"]);
    expect(fingerprint(isolated)).toBe(fingerprint(source));
  });
});
