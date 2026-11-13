import { describe, expect, it } from "vitest";

import {
  OFFICIAL_ASSET_POLICY_ID,
  type OfficialAssetInventory,
} from "../../../../src/host/officialAssetResolution";
import {
  familySpecs,
  nodeDefinitionPayloads,
  templateWithDirectLoaders,
} from "../../../support/officialAssetInventoryFixture";

import {
  assertDrivesDimensions,
  assertNamedWidgetValues,
  assertNoIncomingEdges,
  assertNoOutputEdges,
  collectGeometry,
  createDeniedNetworkRecorder,
  projectGeometryStructure,
  resolveGeometryAssets,
  type GeometryEdge,
} from "./geometryInvariants";

const raw = () => ({
  id: 115,
  type: "ResolutionSelector",
  inputs: [] as {
    name: string;
    type: string;
    widget: boolean;
    link?: number | null;
  }[],
  outputs: [
    { name: "width", type: "INT", links: null as number[] | null },
    { name: "height", type: "INT", links: [] as number[] | null },
  ],
  widgets: [{ name: "megapixels", value: 0.4 }],
});

describe("content-free denied network evidence", () => {
  it("allows retained startup denials only when the interaction denial count is zero", () => {
    const recorder = createDeniedNetworkRecorder("http://127.0.0.1:8188");
    recorder.record("http", "https://example.invalid/startup", "GET");
    recorder.beginInteractionPhase();
    expect(recorder.snapshot()).toMatchObject({
      total: 1,
      startupCount: 1,
      interactionCount: 0,
    });
    recorder.record("download", "http://127.0.0.1:8188/download");
    expect(recorder.snapshot().interactionCount).toBe(1);
  });

  it("classifies every path family and maps WebSocket origins to their HTTP origin", () => {
    const recorder = createDeniedNetworkRecorder("http://127.0.0.1:8188");
    for (const path of ["prompt", "queue", "downloads", "providers", "other"])
      recorder.record(
        "http",
        `http://127.0.0.1:8188/api/${path}?secret=discard`,
        "POST",
      );
    recorder.record("websocket", "ws://127.0.0.1:8188/ws");
    recorder.record(
      "download",
      "https://example.invalid/downloads/private-file",
    );
    const evidence = recorder.snapshot();
    expect(evidence.events.map((event) => event.pathClass)).toEqual([
      "prompt",
      "queue",
      "download",
      "provider",
      "other",
      "other",
      "download",
    ]);
    expect(evidence.events.map((event) => event.originClass)).toEqual([
      "same",
      "same",
      "same",
      "same",
      "same",
      "same",
      "foreign",
    ]);
  });

  it("retains exactly the content-free keys and discards addresses and nonstandard verbs", () => {
    const recorder = createDeniedNetworkRecorder("https://example.invalid");
    recorder.record(
      "http",
      "https://private.invalid/providers/token?secret=hidden",
      "secret-verb",
    );
    recorder.record("websocket", "wss://private.invalid/queue?session=hidden");
    recorder.record("download", "blob:https://example.invalid/private-id");
    const evidence = recorder.snapshot();
    expect(Object.keys(evidence.events[0]).sort()).toEqual([
      "kind",
      "method",
      "originClass",
      "pathClass",
      "phase",
    ]);
    for (const event of evidence.events.slice(1))
      expect(Object.keys(event).sort()).toEqual([
        "kind",
        "originClass",
        "pathClass",
        "phase",
      ]);
    expect(evidence.events[0].method).toBe("OTHER");
    expect(evidence.events[2].originClass).toBe("same");
    expect(JSON.stringify(evidence)).not.toMatch(
      /private|secret|hidden|https?:|wss?:|blob:|token/,
    );
  });

  it("keeps startup evidence and flips immediately without erasing an interaction denial", () => {
    const recorder = createDeniedNetworkRecorder("http://127.0.0.1:8188");
    recorder.record("http", "https://example.invalid/other", "GET");
    recorder.beginInteractionPhase();
    recorder.record("http", "https://example.invalid/other", "GET");
    recorder.beginInteractionPhase();
    expect(recorder.snapshot()).toMatchObject({
      total: 2,
      startupCount: 1,
      interactionCount: 1,
      events: [{ phase: "startup" }, { phase: "interaction" }],
    });
  });

  it("aggregates identical classes and makes per-class counts sum to the derived total", () => {
    const recorder = createDeniedNetworkRecorder("http://127.0.0.1:8188");
    recorder.record("http", "https://example.invalid/one", "GET");
    recorder.record("http", "https://another.invalid/two", "GET");
    recorder.beginInteractionPhase();
    recorder.record("download", "http://127.0.0.1:8188/download");
    const evidence = recorder.snapshot();
    expect(evidence.total).toBe(3);
    expect(evidence.counts.map((row) => row.count)).toEqual([2, 1]);
    expect(evidence.counts.reduce((total, row) => total + row.count, 0)).toBe(
      evidence.total,
    );
    expect(evidence.startupCount + evidence.interactionCount).toBe(
      evidence.total,
    );
  });

  it("does not retain a malformed address and returns independent snapshots", () => {
    const recorder = createDeniedNetworkRecorder("http://127.0.0.1:8188");
    recorder.record("websocket", "not a URL containing private text");
    const first = recorder.snapshot();
    expect(first.events[0]).toEqual({
      kind: "websocket",
      originClass: "foreign",
      pathClass: "other",
      phase: "startup",
    });
    first.events[0].phase = "interaction";
    first.counts[0].count = 999;
    expect(recorder.snapshot()).toMatchObject({
      startupCount: 1,
      interactionCount: 0,
      counts: [{ count: 1 }],
    });
  });
});

describe("geometry invariants across template and host representations", () => {
  it("accepts zero input slots", () => {
    expect(() =>
      assertNoIncomingEdges(projectGeometryStructure(raw()), []),
    ).not.toThrow();
  });

  it("accepts four unlinked widget inputs without copying the template array shape", () => {
    const node = raw();
    node.inputs = ["aspect_ratio", "megapixels", "preview", "multiple"].map(
      (name, index) => ({
        name,
        type: "FLOAT",
        widget: true,
        ...(index % 2 ? { link: null } : {}),
      }),
    );
    expect(() =>
      assertNoIncomingEdges(projectGeometryStructure(node), []),
    ).not.toThrow();
  });

  it("rejects a linked input, including link zero and an inconsistent edge table", () => {
    const node = raw();
    node.inputs = [
      { name: "megapixels", type: "FLOAT", widget: true, link: 0 },
    ];
    expect(() =>
      assertNoIncomingEdges(projectGeometryStructure(node), []),
    ).toThrow("incoming edge");
    expect(() =>
      assertNoIncomingEdges(projectGeometryStructure(raw()), [
        [7, 2, 0, 115, 0, "FLOAT"],
      ]),
    ).toThrow("incoming edge");
  });

  it("accepts null and empty output links regardless of output count", () => {
    const node = raw();
    node.outputs.push({ name: "extra", type: "INT", links: null });
    expect(() =>
      assertNoOutputEdges(projectGeometryStructure(node), []),
    ).not.toThrow();
    expect(() =>
      assertNoOutputEdges(
        projectGeometryStructure({ ...node, outputs: [] }),
        [],
      ),
    ).not.toThrow();
  });

  it("rejects any output link or unlisted outgoing edge", () => {
    const node = raw();
    node.outputs[1].links = [220];
    expect(() =>
      assertNoOutputEdges(projectGeometryStructure(node), []),
    ).toThrow("outgoing edge");
    expect(() =>
      assertNoOutputEdges(projectGeometryStructure(raw()), [
        [220, 115, 1, 105, 3, "INT"],
      ]),
    ).toThrow("outgoing edge");
  });

  const dimensionCase = () => {
    const node = raw();
    node.outputs[0].links = [219];
    node.outputs[1].links = [220];
    return {
      node: projectGeometryStructure(node),
      targets: [
        { name: "width", slot: 2 },
        { name: "height", slot: 3 },
      ],
      edges: [
        [219, 115, 0, 105, 2, "INT"],
        [220, 115, 1, 105, 3, "INT"],
      ] as GeometryEdge[],
    };
  };

  it("accepts FL2VA dimensions by source and target identity", () => {
    const { node, targets, edges } = dimensionCase();
    expect(() =>
      assertDrivesDimensions(node, 105, targets, edges),
    ).not.toThrow();
  });

  it.each(["node", "slot", "extra"])(
    "rejects FL2VA wrong %s target or extra consumer",
    (change) => {
      const { node, targets, edges } = dimensionCase();
      if (change === "node") edges[1][3] = 999;
      if (change === "slot") edges[1][4] = 2;
      if (change === "extra") edges.push([221, 115, 1, 999, 0, "INT"]);
      expect(() => assertDrivesDimensions(node, 105, targets, edges)).toThrow();
    },
  );

  it("reads widget values by name and rejects mismatches, missing names and duplicates", () => {
    const node = projectGeometryStructure(raw());
    expect(() =>
      assertNamedWidgetValues(node, { megapixels: 0.4 }),
    ).not.toThrow();
    expect(() => assertNamedWidgetValues(node, { megapixels: 0.8 })).toThrow(
      "megapixels",
    );
    expect(() => assertNamedWidgetValues(node, { multiple: 32 })).toThrow(
      "multiple",
    );
    node.widgets.push({ name: "megapixels", value: 0.4 });
    expect(() => assertNamedWidgetValues(node, { megapixels: 0.4 })).toThrow(
      "megapixels",
    );
  });

  it("retains both modes once before a later invariant fails", async () => {
    const events: string[] = [];
    const values = await collectGeometry(
      [
        async () => {
          events.push("i2va");
          return raw();
        },
        async () => {
          events.push("fl2va");
          return raw();
        },
      ],
      async (retained) => {
        events.push("attached");
        expect(retained.incomplete).toBe(false);
        expect(retained.projections).toHaveLength(2);
      },
    );
    expect(() =>
      assertNamedWidgetValues(projectGeometryStructure(values[0]), {
        megapixels: 0.8,
      }),
    ).toThrow();
    events.push("asserted");
    expect(events).toEqual(["i2va", "fl2va", "attached", "asserted"]);
  });

  it("retains partial projections once and rethrows the original build failure", async () => {
    const failure = new Error("synthetic geometry build failure");
    const attachments: unknown[] = [];
    await expect(
      collectGeometry(
        [
          async () => "i2va",
          async () => {
            throw failure;
          },
        ],
        async (value) => {
          attachments.push(value);
        },
      ),
    ).rejects.toBe(failure);
    expect(attachments).toEqual([{ projections: ["i2va"], incomplete: true }]);
  });

  it("keeps the build failure primary if partial attachment also fails", async () => {
    const failure = new Error("synthetic geometry build failure");
    await expect(
      collectGeometry(
        [
          async () => {
            throw failure;
          },
        ],
        async () => {
          throw new Error("synthetic retention failure");
        },
      ),
    ).rejects.toBe(failure);
  });
});

describe("official asset route", () => {
  const specs = familySpecs("image_to_video");
  const slots = specs.map((spec) => spec.slot);

  function definitions(inventory: OfficialAssetInventory) {
    return Object.fromEntries(
      Object.entries(nodeDefinitionPayloads(inventory)).map(
        ([name, payload]) => [name, { ...(payload as object), name }],
      ),
    );
  }

  function inventoryFor(value: (spec: (typeof specs)[number]) => string) {
    const inventory: Record<string, string[]> = {};
    for (const spec of specs)
      (inventory[spec.folderCategory] ??= []).push(value(spec));
    return inventory;
  }

  it("resolves host-shaped variants and retains only content-free selection reasons", () => {
    const template = templateWithDirectLoaders();
    const original = structuredClone(template);
    const inventory = inventoryFor((spec) => {
      if (spec.slot === "audio_vae") return spec.templateDefault;
      if (spec.slot === "image_turbo_lora")
        return `Synthetic/Relocated/${spec.templateDefault.toUpperCase()}`;
      const variant = spec.acceptedBasenames.find(
        (name) => name !== spec.templateDefault,
      );
      expect(variant).toBeDefined();
      return `Synthetic/Variants/${variant}`;
    });
    const result = resolveGeometryAssets(
      template,
      "image_to_video",
      definitions(inventory),
    );
    expect(result.receipt).toEqual({
      policyId: OFFICIAL_ASSET_POLICY_ID,
      selections: slots.map((slot) => ({
        slot,
        reason:
          slot === "audio_vae"
            ? "template_default"
            : slot === "image_turbo_lora"
              ? "relocated_default"
              : "official_variant",
      })),
      changedSlots: slots.filter((slot) => slot !== "audio_vae"),
      unresolvedSlots: [],
    });
    expect(result.workflow).not.toEqual(template);
    for (const values of Object.values(inventory))
      for (const value of values)
        expect(JSON.stringify(result.receipt)).not.toContain(value);
    expect(template).toEqual(original);
  });

  it("keeps default-only loader choices and the input template unchanged", () => {
    const template = templateWithDirectLoaders();
    const original = structuredClone(template);
    const result = resolveGeometryAssets(
      template,
      "image_to_video",
      definitions(inventoryFor((spec) => spec.templateDefault)),
    );
    expect(result.receipt).toEqual({
      policyId: OFFICIAL_ASSET_POLICY_ID,
      selections: slots.map((slot) => ({ slot, reason: "template_default" })),
      changedSlots: [],
      unresolvedSlots: [],
    });
    expect(result.workflow).toEqual(original);
    expect(template).toEqual(original);
  });

  it("reports every unresolved slot for empty host combos", () => {
    const template = templateWithDirectLoaders();
    const result = resolveGeometryAssets(
      template,
      "image_to_video",
      definitions({}),
    );
    expect(result.receipt).toEqual({
      policyId: OFFICIAL_ASSET_POLICY_ID,
      selections: [],
      changedSlots: [],
      unresolvedSlots: slots,
    });
    expect(result.workflow).toEqual(template);
  });

  it("retains advisory errors without inventing successful resolution or inventory details", () => {
    const template = templateWithDirectLoaders();
    const result = resolveGeometryAssets(template, "image_to_video", null);
    expect(result.workflow).toBe(template);
    expect(result.receipt).toEqual({
      policyId: OFFICIAL_ASSET_POLICY_ID,
      selections: [],
      changedSlots: [],
      unresolvedSlots: slots,
      errorCode: "invalid_host_inventory",
    });
  });
});
