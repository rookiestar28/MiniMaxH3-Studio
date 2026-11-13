import { describe, expect, it, vi } from "vitest";
import { applySequenceClosingGuide } from "../src/host/sequenceFrameMaterialization";
import { validateSerializedLinks } from "../src/host/graphAdapter";
import type { Json, SpliceResult } from "../src/host/templateGraphTopology";
import { syntheticTemplate } from "./support/templateFixture";
import {
  assertVisibleSequenceFrames,
  preparedSequenceGraphFingerprint,
} from "../src/host/preparedSequenceGraph";
import { SequenceMediaBindingError } from "../src/host/sequenceMediaBindings";

function fixture(nested: boolean): SpliceResult {
  const workflow = syntheticTemplate("video_minimax_h3_i2v");
  const nodes = workflow.nodes as Json[];
  const links = workflow.links as unknown[][];
  const anchor = nodes.find((node) => node.id === 3)!;
  const inputs = anchor.inputs as Json[];
  const vaeSlot = inputs.findIndex((input) => input.name === "vae");
  inputs[vaeSlot]!.link = 22;
  (anchor.outputs as Json[])[0]!.links = [23];
  nodes.push({
    id: 25,
    type: "VAELoader",
    inputs: [],
    outputs: [{ name: "VAE", type: "VAE", links: [22] }],
    widgets_values: ["template-vae.safetensors"],
  });
  nodes.push({
    id: 26,
    type: "BasicGuider",
    inputs: [{ name: "conditioning", type: "CONDITIONING", link: 23 }],
    outputs: [],
    widgets_values: [],
  });
  links.push([22, 25, 0, 3, vaeSlot, "VAE"], [23, 3, 0, 26, 0, "CONDITIONING"]);
  workflow.last_node_id = 26;
  workflow.last_link_id = 23;
  if (nested) {
    const definition: Json = {
      id: "sequence-template-definition",
      inputs: [
        { name: "first_frame", type: "IMAGE", linkIds: [20] },
        { name: "last_frame", type: "IMAGE", linkIds: [21] },
      ],
      outputs: [],
      state: { lastNodeId: 26, lastLinkId: 23 },
      nodes: nodes.filter((node) => node.id !== 9 && node.id !== 10),
      links: links.map((edge) => ({
        id: edge[0],
        origin_id: edge[0] === 20 || edge[0] === 21 ? -10 : edge[1],
        origin_slot: edge[0] === 20 ? 0 : edge[0] === 21 ? 1 : edge[2],
        target_id: edge[3],
        target_slot: edge[4],
        type: edge[5],
      })),
    };
    workflow.nodes = [
      nodes.find((node) => node.id === 9)!,
      nodes.find((node) => node.id === 10)!,
      {
        id: 100,
        type: definition.id,
        inputs: [
          { name: "first_frame", type: "IMAGE", link: 20 },
          { name: "last_frame", type: "IMAGE", link: 21 },
        ],
        outputs: [],
        widgets_values: [],
      },
    ];
    workflow.links = [
      [20, 9, 0, 100, 0, "IMAGE"],
      [21, 10, 0, 100, 1, "IMAGE"],
    ];
    workflow.definitions = { subgraphs: [definition] };
    workflow.last_node_id = 100;
  }
  return {
    workflow,
    anchorNodeId: nested ? 100 : 3,
    promptNodeId: 0,
    ownedNodeIds: [],
    ownedLinkIds: [],
    authoredWidgetNodeIds: [],
    nestedAnchor: nested,
    durationApplied: true,
    artifactPrefixApplied: true,
    mediaNodeIds: {
      firstFrame: 9,
      lastFrame: 10,
      referenceImages: [],
      referenceVideos: [],
      referenceAudios: [],
    },
  };
}

function scope(result: SpliceResult) {
  const instance = (result.workflow.nodes as Json[]).find(
    (node) => node.id === result.anchorNodeId,
  )!;
  const definition = (
    result.workflow.definitions as { subgraphs: Json[] }
  )?.subgraphs.find((row) => row.id === instance.type);
  const graph = result.nestedAnchor ? definition! : result.workflow;
  const nodes = graph.nodes as Json[];
  const links = result.nestedAnchor
    ? (graph.links as Json[]).map((edge) => [
        edge.id,
        edge.origin_id,
        edge.origin_slot,
        edge.target_id,
        edge.target_slot,
        edge.type,
      ])
    : (graph.links as unknown[][]);
  return {
    graph,
    nodes,
    links,
    anchor: nodes.find((node) => node.type === "MiniMaxH3ImageToVideo")!,
  };
}

function assertPrivateGuide(
  original: SpliceResult,
  result: SpliceResult,
  seconds: number,
) {
  const one = <T>(values: T[]): T => {
    expect(values).toHaveLength(1);
    return values[0]!;
  };
  const roots = result.workflow.nodes as Json[];
  const originalInstance = one(
    (original.workflow.nodes as Json[]).filter(
      (node) => node.id === original.anchorNodeId,
    ),
  );
  const instance = one(roots.filter((node) => node.id === result.anchorNodeId));
  const shared = one(
    ((original.workflow.definitions as Json).subgraphs as Json[]).filter(
      (graph) => graph.id === originalInstance.type,
    ),
  );
  expect(instance.type).not.toBe(shared.id);
  expect(instance.type).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const definitions = (result.workflow.definitions as Json).subgraphs as Json[];
  expect(
    JSON.stringify(one(definitions.filter((row) => row.id === shared.id))),
  ).toBe(JSON.stringify(shared));
  const graph = one(definitions.filter((row) => row.id === instance.type));
  const nodes = graph.nodes as Json[];
  const links = graph.links as Json[];
  const node = (type: string) => one(nodes.filter((row) => row.type === type));
  const anchor = node("MiniMaxH3ImageToVideo");
  const vae = node("VAELoader");
  const consumer = node("BasicGuider");
  const decoder = node("VAEDecode");
  const guide = node("MiniMaxH3AddGuide");
  const roles = [anchor, vae, consumer, decoder, guide];
  expect(new Set(roles.map((row) => row.id)).size).toBe(roles.length);
  for (const role of roles) {
    expect(Number.isSafeInteger(role.id)).toBe(true);
    expect(roots.some((row) => row.id === role.id)).toBe(false);
    expect((shared.nodes as Json[]).some((row) => row.id === role.id)).toBe(
      false,
    );
  }
  const port = (owner: Json, direction: "inputs" | "outputs", name: string) =>
    one(
      (owner[direction] as Json[])
        .map((value, slot) => ({ value, slot }))
        .filter((row) => row.value.name === name),
    );
  const expected = [
    [anchor, "positive", 0, guide, "positive", 0, "CONDITIONING"],
    [anchor, "LATENT", 1, guide, "latent", 2, "LATENT"],
    [vae, "VAE", 0, guide, "vae", 1, "VAE"],
    [null, "last_frame", 1, guide, "image", 3, "IMAGE"],
    [guide, "positive", 0, consumer, "conditioning", 0, "CONDITIONING"],
    [anchor, "LATENT", 1, decoder, "samples", 0, "LATENT"],
  ] as const;
  const wired = expected.map(
    ([
      source,
      sourceName,
      sourceSlot,
      target,
      targetName,
      targetSlot,
      type,
    ]) => {
      const targetPort = port(target, "inputs", targetName);
      expect(targetPort.slot).toBe(targetSlot);
      expect(targetPort.value.type).toBe(type);
      const edge = one(
        links.filter(
          (edge) =>
            edge.origin_id === (source?.id ?? -10) &&
            edge.origin_slot === sourceSlot &&
            edge.target_id === target.id &&
            edge.target_slot === targetSlot &&
            edge.type === type,
        ),
      );
      expect(targetPort.value.link).toBe(edge.id);
      if (source) {
        const sourcePort = port(source, "outputs", sourceName);
        expect(sourcePort.slot).toBe(sourceSlot);
        expect(sourcePort.value.type).toBe(type);
        expect(sourcePort.value.links).toContain(edge.id);
      } else {
        const boundary = one(
          (graph.inputs as Json[])
            .map((value, slot) => ({ value, slot }))
            .filter((row) => row.value.name === sourceName),
        );
        expect(boundary.slot).toBe(sourceSlot);
        expect(boundary.value.type).toBe(type);
        expect(boundary.value.linkIds).toEqual([edge.id]);
      }
      return edge;
    },
  );
  expect(port(guide, "outputs", "positive").slot).toBe(0);
  expect(port(guide, "outputs", "positive").value.links).toEqual([
    wired[4]!.id,
  ]);
  expect(port(anchor, "inputs", "last_frame").value.link).toBeNull();
  expect(guide.widgets_values).toEqual([24 * seconds - 1]);
  expect((graph.state as Json).lastNodeId).toBe(guide.id);
  expect(validateSerializedLinks(result.workflow, roots)).toBeUndefined();
  return { graph, roles, wired, vae, shared };
}

function assertPrivateGuideControls(
  original: SpliceResult,
  result: SpliceResult,
  seconds: number,
) {
  const proof = assertPrivateGuide(original, result, seconds);
  for (const edge of proof.wired) {
    const misrouted = structuredClone(result);
    const graph = scope(misrouted).graph;
    const changed = (graph.links as Json[]).find((row) => row.id === edge.id)!;
    changed.target_slot = Number(changed.target_slot) + 1;
    expect(() => assertPrivateGuide(original, misrouted, seconds)).toThrow();
  }
  const oldId = structuredClone(result);
  const oldVae = (proof.shared.nodes as Json[]).find(
    (node) => node.type === "VAELoader",
  )!;
  scope(oldId).nodes.find((node) => node.type === "VAELoader")!.id = oldVae.id;
  expect(() => assertPrivateGuide(original, oldId, seconds)).toThrow();
  const sharedMatch = structuredClone(result);
  (sharedMatch.workflow.nodes as Json[]).find(
    (node) => node.id === sharedMatch.anchorNodeId,
  )!.type = proof.shared.id;
  expect(() => assertPrivateGuide(original, sharedMatch, seconds)).toThrow();

  // Equal inputs AND equal UUID draw: compare every byte, including definition ID.
  const randomUUID = crypto.randomUUID;
  const uuid = vi.spyOn(crypto, "randomUUID");
  const firstUUID = "11111111-1111-4111-8111-111111111111";
  const secondUUID = "22222222-2222-4222-8222-222222222222";
  const definitions = (original.workflow.definitions as Json)
    .subgraphs as Json[];
  expect(
    definitions.some((row) => [firstUUID, secondUUID].includes(String(row.id))),
  ).toBe(false);
  const sameBytes = (first: SpliceResult, second: SpliceResult) =>
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  try {
    uuid.mockReturnValue(firstUUID);
    const first = applySequenceClosingGuide(structuredClone(original), seconds);
    expect(uuid).toHaveBeenCalledTimes(1);
    const second = applySequenceClosingGuide(
      structuredClone(original),
      seconds,
    );
    expect(uuid).toHaveBeenCalledTimes(2);
    sameBytes(first, second);
    const allocationMutant = structuredClone(second);
    const allocated = scope(allocationMutant).nodes.find(
      (node) => node.type === "MiniMaxH3AddGuide",
    )!;
    allocated.id = Number(allocated.id) + 1;
    expect(() => sameBytes(first, allocationMutant)).toThrow();
    uuid
      .mockReset()
      .mockReturnValueOnce(firstUUID)
      .mockReturnValueOnce(secondUUID);
    const drawOne = applySequenceClosingGuide(
      structuredClone(original),
      seconds,
    );
    expect(uuid).toHaveBeenCalledTimes(1);
    const drawTwo = applySequenceClosingGuide(
      structuredClone(original),
      seconds,
    );
    expect(uuid).toHaveBeenCalledTimes(2);
    expect(() => sameBytes(drawOne, drawTwo)).toThrow();
  } finally {
    uuid.mockRestore();
  }
  expect(crypto.randomUUID).toBe(randomUUID);
}

describe("owned sequence closing-frame topology", () => {
  it("pins private nested guide semantics while ignoring layout and unrelated instances", () => {
    const result = applySequenceClosingGuide(fixture(true), 6);
    const inputs = {
      task_mode: "fl2va" as const,
      user_intent: "Synthetic guard",
      duration_milliseconds: 6000,
      frame_count: 141,
    };
    assertVisibleSequenceFrames(
      result.workflow,
      result.anchorNodeId,
      result.mediaNodeIds,
      inputs,
    );
    const before = preparedSequenceGraphFingerprint(
      result.workflow,
      result.anchorNodeId,
      result.mediaNodeIds,
    );
    const { nodes } = scope(result);
    const guide = nodes.find((node) => node.type === "MiniMaxH3AddGuide")!;
    guide.pos = [1000, 2000];
    (guide.inputs as Json[]).push({
      name: "host_appended_optional",
      type: "STRING",
      link: null,
    });
    ((result.workflow.definitions as Json).subgraphs as Json[])[0]!.title =
      "Unrelated source definition layout";
    expect(
      preparedSequenceGraphFingerprint(
        result.workflow,
        result.anchorNodeId,
        result.mediaNodeIds,
      ),
    ).toBe(before);
    (guide.widgets_values as unknown[])[0] = 157;
    expect(() =>
      assertVisibleSequenceFrames(
        result.workflow,
        result.anchorNodeId,
        result.mediaNodeIds,
        inputs,
      ),
    ).toThrow("sequence_media_changed");
    expect(
      preparedSequenceGraphFingerprint(
        result.workflow,
        result.anchorNodeId,
        result.mediaNodeIds,
      ),
    ).not.toBe(before);
  });
  it("isolates the owned instance from the shared definition and another instance", () => {
    const original = fixture(true);
    const instance = (original.workflow.nodes as Json[]).find(
      (node) => node.id === original.anchorNodeId,
    )!;
    const other = {
      ...structuredClone(instance),
      id: 101,
      inputs: (instance.inputs as Json[]).map((port) => ({
        ...port,
        link: null,
      })),
    };
    (original.workflow.nodes as Json[]).push(other);
    const definition = (original.workflow.definitions as { subgraphs: Json[] })
      .subgraphs[0]!;
    const definitionBytes = JSON.stringify(definition),
      otherBytes = JSON.stringify(other);
    const result = applySequenceClosingGuide(original, 6);
    const definitions = (result.workflow.definitions as { subgraphs: Json[] })
      .subgraphs;
    const owned = (result.workflow.nodes as Json[]).find(
      (node) => node.id === instance.id,
    )!;
    expect(definitions).toHaveLength(2);
    expect(owned.type).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(owned.type).not.toBe(instance.type);
    expect(
      JSON.stringify(definitions.find((row) => row.id === definition.id)),
    ).toBe(definitionBytes);
    expect(
      JSON.stringify(
        (result.workflow.nodes as Json[]).find((node) => node.id === other.id),
      ),
    ).toBe(otherBytes);
    expect(
      JSON.stringify(
        (original.workflow.definitions as { subgraphs: Json[] }).subgraphs[0],
      ),
    ).toBe(definitionBytes);
    expect(
      (
        definitions.find((row) => row.id === owned.type)!.nodes as Json[]
      ).filter((node) => node.type === "MiniMaxH3AddGuide"),
    ).toHaveLength(1);
  });

  it.each(
    [false, true].flatMap((nested) =>
      [6, 8, 13].map((seconds) => ({ nested, seconds })),
    ),
  )(
    "places $seconds s closing frame at the kept interval in nested=$nested",
    ({ nested, seconds }) => {
      const original = fixture(nested);
      const before = structuredClone(original);
      const result = applySequenceClosingGuide(original, seconds);
      expect(original).toEqual(before);
      if (nested) {
        assertPrivateGuideControls(before, result, seconds);
        return;
      }
      const { graph, nodes, links, anchor } = scope(result);
      const guides = nodes.filter((node) => node.type === "MiniMaxH3AddGuide");
      expect(guides).toHaveLength(1);
      const guide = guides[0]!;
      expect(guide.widgets_values).toEqual([24 * seconds - 1]);
      expect(
        (anchor.inputs as Json[]).find((input) => input.name === "last_frame")!
          .link,
      ).toBeNull();
      const incoming = (name: string) => {
        const slot = (guide.inputs as Json[]).findIndex(
          (input) => input.name === name,
        );
        return links.find((edge) => edge[3] === guide.id && edge[4] === slot)!;
      };
      expect(incoming("positive").slice(1, 3)).toEqual([anchor.id, 0]);
      expect(incoming("latent").slice(1, 3)).toEqual([anchor.id, 1]);
      expect(incoming("vae").slice(1, 3)).toEqual([25, 0]);
      expect(incoming("image").slice(1, 3)).toEqual(
        nested ? [-10, 1] : [10, 0],
      );
      expect(links.find((edge) => edge[0] === 23)!.slice(1, 5)).toEqual([
        guide.id,
        0,
        26,
        0,
      ]);
      expect(links.find((edge) => edge[0] === 12)!.slice(1, 5)).toEqual([
        3, 1, 4, 0,
      ]);
      expect((guide.outputs as Json[])[0]!.links).toEqual([23]);
      expect(graph.last_node_id ?? (graph.state as Json).lastNodeId).toBe(
        guide.id,
      );
      expect(
        validateSerializedLinks(
          result.workflow,
          result.workflow.nodes as Json[],
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    "missing_vae",
    "missing_positive_consumer",
    "duplicate_anchor",
    "wrong_last_origin",
  ])("refuses %s before changing the supplied graph", (defect) => {
    const result = fixture(false);
    const { nodes, links, anchor } = scope(result);
    if (defect === "missing_vae")
      (anchor.inputs as Json[]).find((input) => input.name === "vae")!.link =
        null;
    if (defect === "missing_positive_consumer")
      (anchor.outputs as Json[])[0]!.links = [];
    if (defect === "duplicate_anchor")
      nodes.push({ ...structuredClone(anchor), id: 27 });
    if (defect === "wrong_last_origin")
      links.find((edge) => edge[0] === 21)![1] = 9;
    const before = structuredClone(result);
    expect(() => applySequenceClosingGuide(result, 6)).toThrow(
      /closing_guide_seam/,
    );
    expect(result).toEqual(before);
  });
});

describe("nested unused frame promotions", () => {
  type Mode = "i2va" | "t2va" | "l2va";

  function omitFrameId(
    result: SpliceResult,
    role: "first_frame" | "last_frame",
  ): SpliceResult {
    const key = role === "first_frame" ? "firstFrame" : "lastFrame";
    const { [key]: _omitted, ...mediaNodeIds } = result.mediaNodeIds;
    return { ...result, mediaNodeIds };
  }

  function disconnectOuterFrame(
    result: SpliceResult,
    role: "first_frame" | "last_frame",
  ) {
    const roots = result.workflow.nodes as Json[];
    const instance = roots.find((node) => node.id === result.anchorNodeId)!;
    const port = (instance.inputs as Json[]).find((row) => row.name === role)!;
    const linkId = port.link;
    port.link = null;
    result.workflow.links = (result.workflow.links as unknown[][]).filter(
      (edge) => edge[0] !== linkId,
    );
    for (const node of roots)
      for (const output of (node.outputs as Json[] | undefined) ?? [])
        if (Array.isArray(output.links))
          output.links = output.links.filter((id) => id !== linkId);
    return omitFrameId(result, role);
  }

  function dormantFixture(mode: Mode) {
    let result =
      mode === "l2va"
        ? applySequenceClosingGuide(fixture(true), 6)
        : fixture(true);
    if (mode !== "i2va") result = disconnectOuterFrame(result, "first_frame");
    if (mode !== "l2va") result = disconnectOuterFrame(result, "last_frame");
    return result;
  }

  function assertFrames(result: SpliceResult, mode: Mode) {
    assertVisibleSequenceFrames(
      result.workflow,
      result.anchorNodeId,
      result.mediaNodeIds,
      {
        task_mode: mode,
        user_intent: "Synthetic dormant frame promotion",
        duration_milliseconds: 6000,
        frame_count: 141,
      },
    );
  }

  it.each(["i2va", "t2va", "l2va"] as const)(
    "accepts nested %s with dormant unused frame promotions",
    (mode) => {
      // Keep the definition's boundary wiring: only the instance's unused input is unbound.
      assertFrames(dormantFixture(mode), mode);
    },
  );

  it.each([
    "connected_outer_last_frame",
    "wrong_required_first_source",
    "wrong_required_first_slot",
    "internal_node_native_last_edge",
    "wrong_boundary_slot",
    "wrong_boundary_role",
    "duplicate_definition_promotion",
    "missing_definition_promotion",
    "duplicate_outer_promotion",
    "missing_outer_promotion",
    "dangling_outer_input",
    "dangling_outer_edge",
    "promoted_image_widget_fallback",
  ] as const)("refuses %s despite an optional promotion", (defect) => {
    const result =
      defect === "connected_outer_last_frame"
        ? fixture(true)
        : dormantFixture("i2va");
    const roots = result.workflow.nodes as Json[];
    const instance = roots.find((node) => node.id === result.anchorNodeId)!;
    const outerPorts = instance.inputs as Json[];
    const outerLast = outerPorts.find((port) => port.name === "last_frame")!;
    const definition = (
      result.workflow.definitions as { subgraphs: Json[] }
    ).subgraphs.find((row) => row.id === instance.type)!;
    const promotions = definition.inputs as Json[];
    const edges = definition.links as Json[];
    const nativeLast = edges.find((edge) => edge.id === 21)!;
    const rootEdges = result.workflow.links as unknown[][];
    const firstLoader = roots.find((node) => node.id === 9)!;
    const lastLoader = roots.find((node) => node.id === 10)!;
    const firstOutput = (firstLoader.outputs as Json[])[0]!;

    if (defect === "wrong_required_first_source") {
      rootEdges.find((edge) => edge[0] === 20)![1] = 10;
      firstOutput.links = [];
      (lastLoader.outputs as Json[])[0]!.links = [20];
    }
    if (defect === "wrong_required_first_slot") {
      rootEdges.find((edge) => edge[0] === 20)![2] = 1;
      firstOutput.links = [];
      (firstLoader.outputs as Json[]).push({
        name: "second_image",
        type: "IMAGE",
        links: [20],
      });
    }
    if (defect === "internal_node_native_last_edge") {
      const internal: Json = { ...structuredClone(lastLoader), id: 27 };
      (internal.outputs as Json[])[0]!.links = [21];
      (definition.nodes as Json[]).push(internal);
      nativeLast.origin_id = 27;
      nativeLast.origin_slot = 0;
      promotions[1]!.linkIds = [];
    }
    if (defect === "wrong_boundary_slot") {
      nativeLast.origin_slot = 0;
      promotions[0]!.linkIds = [20, 21];
      promotions[1]!.linkIds = [];
    }
    if (defect === "wrong_boundary_role") {
      promotions[1]!.name = "another_image";
      outerLast.name = "another_image";
    }
    if (defect === "duplicate_definition_promotion")
      promotions.push({ name: "last_frame", type: "IMAGE", linkIds: [] });
    if (defect === "missing_definition_promotion") promotions.splice(1, 1);
    if (defect === "duplicate_outer_promotion")
      outerPorts.push({ name: "last_frame", type: "IMAGE", link: null });
    if (defect === "missing_outer_promotion") outerPorts.splice(1, 1);
    if (defect === "dangling_outer_input") outerLast.link = 999;
    if (defect === "dangling_outer_edge") {
      rootEdges.push([21, 10, 0, 100, 1, "IMAGE"]);
      (lastLoader.outputs as Json[])[0]!.links = [21];
    }
    if (defect === "promoted_image_widget_fallback")
      outerLast.widgetId = "synthetic-image-widget";

    let refusal: unknown;
    try {
      assertFrames(result, "i2va");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SequenceMediaBindingError);
    expect(refusal).toMatchObject({ category: "sequence_media_changed" });
  });

  const requiredRoles = {
    t2va: [false, false],
    i2va: [true, false],
    l2va: [false, true],
    fl2va: [true, true],
  } as const;
  const topologyCases = [false, true].flatMap((nested) =>
    (Object.keys(requiredRoles) as (keyof typeof requiredRoles)[]).flatMap(
      (mode) =>
        [false, true].flatMap((firstPresent) =>
          [false, true].map((lastPresent) => ({
            nested,
            mode,
            firstPresent,
            lastPresent,
            accepted:
              firstPresent === requiredRoles[mode][0] &&
              lastPresent === requiredRoles[mode][1],
          })),
        ),
    ),
  );

  it.each(topologyCases)(
    "enforces mode=$mode nested=$nested first=$firstPresent last=$lastPresent accepted=$accepted",
    ({ mode, nested, firstPresent, lastPresent, accepted }) => {
      let result = fixture(nested);
      if (mode === "l2va" || mode === "fl2va")
        result = applySequenceClosingGuide(result, 6);
      for (const [role, present, loaderId] of [
        ["first_frame", firstPresent, 9],
        ["last_frame", lastPresent, 10],
      ] as const) {
        if (present) continue;
        if (nested) {
          result = disconnectOuterFrame(result, role);
          continue;
        }
        const edges = result.workflow.links as unknown[][];
        const removed = new Set(
          edges.filter((edge) => edge[1] === loaderId).map((edge) => edge[0]),
        );
        result.workflow.links = edges.filter((edge) => !removed.has(edge[0]));
        for (const node of result.workflow.nodes as Json[]) {
          for (const port of (node.inputs as Json[] | undefined) ?? [])
            if (removed.has(port.link)) port.link = null;
          for (const port of (node.outputs as Json[] | undefined) ?? [])
            if (Array.isArray(port.links))
              port.links = port.links.filter((id) => !removed.has(id));
        }
        result = omitFrameId(result, role);
      }
      const verify = () =>
        assertVisibleSequenceFrames(
          result.workflow,
          result.anchorNodeId,
          result.mediaNodeIds,
          {
            task_mode: mode,
            user_intent: "Synthetic frame role contract matrix",
            duration_milliseconds: 6000,
            frame_count: 141,
          },
        );
      if (accepted) expect(verify).not.toThrow();
      else expect(verify).toThrow(SequenceMediaBindingError);
    },
  );
});
