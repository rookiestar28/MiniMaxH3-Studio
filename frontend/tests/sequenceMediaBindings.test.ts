import { describe, expect, it } from "vitest";
import {
  decodeSequenceMediaBindingSet,
  sequenceMediaBindingFingerprint,
} from "../src/host/sequenceMediaBindings";

function entry(maximum = false) {
  const node = (value: string) => (maximum ? value.padEnd(128, "n") : value);
  return {
    asset_id: node("asset0"),
    role: "first_frame",
    kind: "image",
    loader_class: "LoadImage",
    loader_node_id: node("loader0"),
    locator: maximum ? "🌟".repeat(512) : "synthetic/source0.png",
    source_identity: {
      schema: "h3.context.input_geometry.receipt.v2",
      receipt_handle: "ig_" + "r".repeat(96),
      source_fingerprint: "sha256:" + "a".repeat(64),
    },
    registry_endpoint: {
      node_id: node("registry"),
      input_name: node("image_0"),
      source_node_id: node("crop0"),
      source_slot: 0,
    },
    transform: {
      node_id: node("crop0"),
      class_type: "ImageCropV2",
      region: { x: 16352, y: 16352, width: 32, height: 32 },
    },
  };
}
const wire = (row = entry()) => ({
  schema: "h3.context.sequence_media_binding_set.v1",
  entries: [row],
});

describe("private sequence image binding codec", () => {
  it("admits the maximum Unicode locator and bounded node identities", () => {
    const value = wire(entry(true));
    expect(decodeSequenceMediaBindingSet(value)).toEqual(value);
    expect(
      new TextEncoder().encode(JSON.stringify(value.entries[0])).byteLength,
    ).toBeLessThanOrEqual(4096);
    expect(
      Object.isFrozen(
        decodeSequenceMediaBindingSet(value).entries[0].transform?.region,
      ),
    ).toBe(true);
  });
  it("refuses maximum plus one bytes and unknown fields without reflecting private data", () => {
    const value = entry();
    value.locator = "x".repeat(4097);
    expect(() => decodeSequenceMediaBindingSet(wire(value))).toThrow(
      "sequence_media_binding_size",
    );
    expect(() =>
      decodeSequenceMediaBindingSet({ ...wire(), foreign: "private-marker" }),
    ).toThrow("sequence_media_binding_invalid");
  });
  it.each([
    "kind",
    "loader",
    "chain",
    "extra",
    "region_extra",
    "sum",
    "bool",
    "small",
    "slot",
    "traversal",
  ])("refuses invalid %s", (change) => {
    const value: any = wire();
    const row = value.entries[0];
    if (change === "kind") row.kind = "video";
    if (change === "loader") row.loader_class = "LoadVideo";
    if (change === "chain") row.transform.class_type = "ImageScale";
    if (change === "extra") row.foreign = true;
    if (change === "region_extra") row.transform.region.other = 1;
    if (change === "sum") row.transform.region.x = 16353;
    if (change === "bool") row.transform.region.x = true;
    if (change === "small") row.transform.region.width = 31;
    if (change === "slot") row.registry_endpoint.source_slot = 1;
    if (change === "traversal") row.locator = "../source.png";
    expect(() => decodeSequenceMediaBindingSet(value)).toThrow(
      "sequence_media_binding_invalid",
    );
  });
  it("fingerprints source, endpoint and crop while renewing receipt handles", () => {
    const first = wire();
    const original = sequenceMediaBindingFingerprint(
      decodeSequenceMediaBindingSet(first),
    );
    first.entries[0].source_identity.receipt_handle = "ig_" + "s".repeat(40);
    expect(
      sequenceMediaBindingFingerprint(decodeSequenceMediaBindingSet(first)),
    ).toBe(original);
    first.entries[0].transform.region.x -= 1;
    expect(
      sequenceMediaBindingFingerprint(decodeSequenceMediaBindingSet(first)),
    ).not.toBe(original);
  });
  it("preserves exact locator codepoints in the private identity", () => {
    const first = wire();
    first.entries[0].locator = "synthetic/\u00e9.png";
    const second = structuredClone(first);
    second.entries[0].locator = "synthetic/e\u0301.png";
    expect(
      sequenceMediaBindingFingerprint(decodeSequenceMediaBindingSet(first)),
    ).not.toBe(
      sequenceMediaBindingFingerprint(decodeSequenceMediaBindingSet(second)),
    );
  });
});
