import {
  definitionEdges,
  tupleEdges,
  type SerializedEdge,
} from "./graphSerialization";
import {
  isRecord,
  TemplateSpliceError,
  type Json,
  type SpliceResult,
} from "./templateGraphTopology";
import { closingGuideNamespace } from "./closingGuideNamespace";

const refuse = (): never => {
  throw new TemplateSpliceError("closing_guide_seam", "closing_guide_seam");
};
const rows = (value: unknown): Json[] =>
  Array.isArray(value) && value.every(isRecord) ? value : refuse();
const one = <T>(values: T[]): T =>
  values.length === 1 ? values[0]! : refuse();

function input(node: Json, name: string) {
  return one(
    rows(node.inputs)
      .map((port, slot) => ({ port, slot }))
      .filter((row) => row.port.name === name),
  );
}

function output(node: Json, name: string) {
  return one(
    rows(node.outputs)
      .map((port, slot) => ({ port, slot }))
      .filter((row) => row.port.name === name),
  );
}

/** Retained sequence closing frames use an explicit kept-interval guide. */
export function applySequenceClosingGuide(
  result: SpliceResult,
  durationSeconds: number,
): SpliceResult {
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 4 ||
    durationSeconds > 15 ||
    result.mediaNodeIds.lastFrame === undefined
  )
    return refuse();
  const cloned = structuredClone(result);
  const workflow = cloned.workflow;
  const roots = rows(workflow.nodes);
  const instance = one(roots.filter((node) => node.id === result.anchorNodeId));
  const rootEdges = tupleEdges(workflow.links) ?? refuse();
  const declaredLast = input(instance, "last_frame");
  const rootLast = one(
    rootEdges.filter(
      (edge) =>
        edge.id === declaredLast.port.link &&
        edge.targetId === String(instance.id) &&
        edge.targetSlot === declaredLast.slot,
    ),
  );
  const loaderId = result.mediaNodeIds.lastFrame;
  const endpoint =
    result.mediaNodeIds.retainedCrops?.[String(loaderId)]?.nodeId ??
    result.mediaNodeIds.crops?.[String(loaderId)]?.nodeId ??
    loaderId;
  if (
    rootLast.originId !== String(endpoint) ||
    rootLast.originSlot !== 0 ||
    rootLast.type !== "IMAGE"
  )
    return refuse();

  const namespace = closingGuideNamespace(workflow, refuse);
  let graph = workflow;
  if (result.nestedAnchor) {
    const definitions = rows(
      isRecord(workflow.definitions)
        ? workflow.definitions.subgraphs
        : undefined,
    );
    const shared = one(
      definitions.filter((definition) => definition.id === instance.type),
    );
    const privateId = crypto.randomUUID();
    if (
      definitions.some((definition) => definition.id === privateId) ||
      (instance.subgraph_id !== undefined && instance.subgraph_id !== shared.id)
    )
      return refuse();
    // CRITICAL: another instance may share this definition even in the owned graph.
    // Guide insertion must never change that instance's native keyframe semantics.
    const privateDefinition = structuredClone(shared);
    privateDefinition.id = privateId;
    // CRITICAL: frontend 1.57.1 normalizes node AND link IDs across definitions.
    // Fresh clone IDs and references prevent host renumbering from changing the fingerprint.
    namespace.remapDefinition(privateDefinition, instance);
    definitions.push(privateDefinition);
    instance.type = privateId;
    if (instance.subgraph_id !== undefined) instance.subgraph_id = privateId;
    graph = privateDefinition;
  }
  const nodes = rows(graph.nodes);
  const anchor = one(
    nodes.filter((node) => node.type === "MiniMaxH3ImageToVideo"),
  );
  if (nodes.some((node) => node.type === "MiniMaxH3AddGuide")) return refuse();
  const edges =
    (result.nestedAnchor
      ? definitionEdges(graph.links)
      : tupleEdges(graph.links)) ?? refuse();
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length)
    return refuse();
  const last = input(anchor, "last_frame");
  const vae = input(anchor, "vae");
  const incoming = (port: ReturnType<typeof input>, type: string) =>
    one(
      edges.filter(
        (edge) =>
          edge.id === port.port.link &&
          edge.targetId === String(anchor.id) &&
          edge.targetSlot === port.slot &&
          edge.type === type,
      ),
    );
  const lastEdge = incoming(last, "IMAGE");
  const vaeEdge = incoming(vae, "VAE");
  if (result.nestedAnchor) {
    const promoted = one(
      rows(graph.inputs)
        .map((port, slot) => ({ port, slot }))
        .filter((row) => row.port.name === "last_frame"),
    );
    if (
      lastEdge.originId !== "-10" ||
      lastEdge.originSlot !== promoted.slot ||
      !Array.isArray(promoted.port.linkIds) ||
      !promoted.port.linkIds.includes(lastEdge.id)
    )
      return refuse();
  } else if (lastEdge.id !== rootLast.id) return refuse();
  const vaeNode = one(
    nodes.filter((node) => String(node.id) === vaeEdge.originId),
  );
  const vaeOutput = rows(vaeNode.outputs)[vaeEdge.originSlot] ?? refuse();
  if (
    vaeOutput.type !== "VAE" ||
    !Array.isArray(vaeOutput.links) ||
    !vaeOutput.links.includes(vaeEdge.id)
  )
    return refuse();
  const positive = output(anchor, "positive"),
    latent = output(anchor, "LATENT");
  if (
    positive.port.type !== "CONDITIONING" ||
    latent.port.type !== "LATENT" ||
    !Array.isArray(positive.port.links) ||
    positive.port.links.length === 0 ||
    !Array.isArray(latent.port.links)
  )
    return refuse();
  const consumers = positive.port.links.map((id) =>
    one(
      edges.filter(
        (edge) =>
          edge.id === id &&
          edge.originId === String(anchor.id) &&
          edge.originSlot === positive.slot &&
          edge.type === "CONDITIONING",
      ),
    ),
  );
  for (const edge of consumers) {
    const target = one(
      nodes.filter((node) => String(node.id) === edge.targetId),
    );
    if (rows(target.inputs)[edge.targetSlot]?.link !== edge.id) return refuse();
  }
  const state = result.nestedAnchor
    ? isRecord(graph.state)
      ? graph.state
      : {}
    : graph;
  const nodeKey = result.nestedAnchor ? "lastNodeId" : "last_node_id";
  const linkKey = result.nestedAnchor ? "lastLinkId" : "last_link_id";
  const guideId = namespace.next("node");
  const guideLinks = [
    namespace.next("link"),
    namespace.next("link"),
    namespace.next("link"),
  ];
  let guideLinkIndex = 0;
  const guide: Json = {
    id: guideId,
    type: "MiniMaxH3AddGuide",
    pos: [600, 200],
    size: [300, 180],
    flags: {},
    mode: 0,
    order: nodes.length,
    properties: {},
    inputs: [
      { name: "positive", type: "CONDITIONING", link: null },
      { name: "vae", type: "VAE", link: null },
      { name: "latent", type: "LATENT", link: null },
      { name: "image", type: "IMAGE", link: lastEdge.id },
      {
        name: "frame_idx",
        type: "INT",
        link: null,
        widget: { name: "frame_idx" },
      },
    ],
    outputs: [
      {
        name: "positive",
        type: "CONDITIONING",
        links: consumers.map((edge) => edge.id),
      },
    ],
    widgets_values: [24 * durationSeconds - 1],
  };
  const writeEdge = (edge: SerializedEdge): void => {
    const raw =
      (graph.links as unknown[]).find((value) =>
        Array.isArray(value)
          ? value[0] === edge.id
          : isRecord(value) && value.id === edge.id,
      ) ?? refuse();
    if (Array.isArray(raw)) {
      raw[1] = Number(edge.originId);
      raw[2] = edge.originSlot;
      raw[3] = Number(edge.targetId);
      raw[4] = edge.targetSlot;
    } else
      Object.assign(raw, {
        origin_id: Number(edge.originId),
        origin_slot: edge.originSlot,
        target_id: Number(edge.targetId),
        target_slot: edge.targetSlot,
      });
  };
  // CRITICAL: the closing image belongs to the kept interval, not native padding.
  // Keep anchor.last_frame empty; its native end index can be discarded during assembly.
  last.port.link = null;
  writeEdge({ ...lastEdge, targetId: String(guideId), targetSlot: 3 });
  for (const edge of consumers)
    writeEdge({ ...edge, originId: String(guideId), originSlot: 0 });
  positive.port.links = [];
  const append = (
    source: Json,
    sourceSlot: number,
    targetSlot: number,
    type: string,
  ): void => {
    const id = guideLinks[guideLinkIndex++] ?? refuse();
    const sourceOutput = rows(source.outputs)[sourceSlot] ?? refuse();
    sourceOutput.links = [
      ...(Array.isArray(sourceOutput.links) ? sourceOutput.links : []),
      id,
    ];
    rows(guide.inputs)[targetSlot]!.link = id;
    (graph.links as unknown[]).push(
      result.nestedAnchor
        ? {
            id,
            origin_id: source.id,
            origin_slot: sourceSlot,
            target_id: guideId,
            target_slot: targetSlot,
            type,
          }
        : [id, source.id, sourceSlot, guideId, targetSlot, type],
    );
  };
  append(anchor, positive.slot, 0, "CONDITIONING");
  append(vaeNode, vaeEdge.originSlot, 1, "VAE");
  append(anchor, latent.slot, 2, "LATENT");
  nodes.push(guide);
  state[nodeKey] = guideId;
  state[linkKey] = Math.max(...guideLinks);
  if (result.nestedAnchor) graph.state = state;
  return cloned;
}
