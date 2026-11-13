/** Volatile media/guide identity; no locator or additional fingerprint enters a wire. */
import { sha256Text } from "../contracts/canonicalFingerprint";
import type { SequenceFailureAttribution } from "./managedSequenceDiagnostics";
import {
  AppModeError,
  graphNodes,
  record,
  type AppModeInputs,
} from "./appModeContract";
import {
  definitionEdges,
  tupleEdges,
  type SerializedEdge,
} from "./graphSerialization";
import { SequenceMediaBindingError } from "./sequenceMediaBindings";
import {
  FRAME_BINDINGS,
  I2VA_SCALE_NODE_TYPE,
  I2VA_SIZE_NODE_TYPE,
  type SpliceMediaIds,
} from "./templateGraphTopology";

type Node = Record<string, unknown>;
const changed = (): never => {
  throw new SequenceMediaBindingError("sequence_media_changed", {
    origin: "visible-guide",
    boundary: "source-observe",
    managedAction: "unattributed",
    httpStatusClass: "unattributed",
  });
};
const one = <T>(rows: readonly T[]): T =>
  rows.length === 1 ? rows[0]! : changed();
const rows = (value: unknown): Node[] =>
  Array.isArray(value)
    ? value.map((value) => record(value) ?? changed())
    : changed();
const ports = (node: Node, direction: "inputs" | "outputs") =>
  node[direction] === undefined ? [] : rows(node[direction]);
const mediaTypes = new Set([
  "LoadImage",
  "ImageCropV2",
  I2VA_SCALE_NODE_TYPE,
  I2VA_SIZE_NODE_TYPE,
  "MiniMaxH3AddGuide",
]);
const endpoint = (ids: SpliceMediaIds, loader: number | undefined) =>
  loader === undefined
    ? undefined
    : (ids.retainedCrops?.[String(loader)]?.nodeId ?? loader);

function scope(value: unknown, anchorNodeId: number) {
  const roots = graphNodes(value).map((value) => record(value) ?? changed());
  const instance = one(
    roots.filter((node) => String(node.id) === String(anchorNodeId)),
  );
  const rootEdges = tupleEdges(record(value)?.links) ?? changed();
  const nested = instance.type !== "MiniMaxH3ImageToVideo";
  const definition = nested
    ? one(
        rows(record(record(value)?.definitions)?.subgraphs).filter(
          (row) => row.id === instance.type,
        ),
      )
    : undefined;
  const nodes = definition === undefined ? roots : rows(definition.nodes);
  const edges =
    definition === undefined
      ? rootEdges
      : (definitionEdges(definition.links) ?? changed());
  const anchor = one(
    nodes.filter((node) => node.type === "MiniMaxH3ImageToVideo"),
  );
  return {
    roots,
    instance,
    rootEdges,
    nested,
    definition,
    nodes,
    edges,
    anchor,
  };
}

function incoming(
  nodes: Node[],
  edges: SerializedEdge[],
  node: Node,
  name: string,
): SerializedEdge | undefined {
  const matching = ports(node, "inputs")
    .map((port, slot) => ({ port, slot }))
    .filter((row) => row.port.name === name);
  if (!matching.length) return undefined;
  const { port, slot } = one(matching);
  if (port.link === null || port.link === undefined) {
    if (
      edges.some(
        (edge) => edge.targetId === String(node.id) && edge.targetSlot === slot,
      )
    )
      return changed();
    return undefined;
  }
  const edge = one(
    edges.filter(
      (edge) =>
        edge.id === port.link &&
        edge.targetId === String(node.id) &&
        edge.targetSlot === slot,
    ),
  );
  if (
    edge.originId !== "-10" &&
    !nodes.some((node) => String(node.id) === edge.originId)
  )
    return changed();
  return edge;
}

/** Prove the visible native/guide branch independently from an older compile result. */
export function assertVisibleSequenceFrames(
  value: unknown,
  anchorNodeId: number,
  ids: SpliceMediaIds,
  inputs: AppModeInputs,
): void {
  const {
    roots,
    instance,
    rootEdges,
    nested,
    definition,
    nodes,
    edges,
    anchor,
  } = scope(value, anchorNodeId);
  const roles = FRAME_BINDINGS[inputs.task_mode] ?? changed();
  const matches = (
    edge: SerializedEdge | undefined,
    id: string | number | undefined,
    slot: number,
  ) =>
    edge !== undefined &&
    id !== undefined &&
    edge.originId === String(id) &&
    edge.originSlot === slot;
  const frame = (
    role: "first_frame" | "last_frame",
    target: Node,
    input: string,
  ) => {
    const expected = endpoint(
      ids,
      role === "first_frame" ? ids.firstFrame : ids.lastFrame,
    );
    const source = incoming(nodes, edges, target, input);
    if (!nested) return matches(source, expected, 0);
    const promoted = rows(definition!.inputs)
      .map((port, slot) => ({ port, slot }))
      .filter((row) => row.port.name === role);
    return (
      matches(incoming(roots, rootEdges, instance, role), expected, 0) &&
      matches(source, "-10", one(promoted).slot)
    );
  };
  // IMPORTANT: a dormant promoted edge supplies no image when its outer IMAGE
  // input is unbound. Only a consistent same-role boundary is absent; connected,
  // internal, malformed or wrong-slot edges must still refuse.
  const optionalFrameAbsent = (
    source: SerializedEdge | undefined,
    role: "first_frame" | "last_frame",
  ) => {
    if (source === undefined) return true;
    if (!nested || source.originId !== "-10") return false;
    const promoted = one(
      rows(definition!.inputs)
        .map((port, slot) => ({ port, slot }))
        .filter((row) => row.port.name === role),
    );
    const outer = one(
      ports(instance, "inputs")
        .map((port, slot) => ({ port, slot }))
        .filter((row) => row.port.name === role),
    );
    if (
      source.type !== "IMAGE" ||
      promoted.port.type !== "IMAGE" ||
      outer.port.type !== "IMAGE" ||
      source.originSlot !== promoted.slot ||
      outer.slot !== promoted.slot ||
      !Array.isArray(promoted.port.linkIds) ||
      promoted.port.linkIds.filter((id) => id === source.id).length !== 1 ||
      edges.filter((edge) => edge.id === source.id).length !== 1 ||
      outer.port.widgetId != null ||
      outer.port.widget != null
    )
      return false;
    return incoming(roots, rootEdges, instance, role) === undefined;
  };
  const first = incoming(nodes, edges, anchor, "first_frame");
  if (
    roles.includes("first_frame")
      ? !frame("first_frame", anchor, "first_frame")
      : !optionalFrameAbsent(first, "first_frame")
  )
    return changed();
  if (
    !optionalFrameAbsent(
      incoming(nodes, edges, anchor, "last_frame"),
      "last_frame",
    )
  )
    return changed();
  const guides = nodes.filter((node) => node.type === "MiniMaxH3AddGuide");
  if (!roles.includes("last_frame")) {
    if (guides.length) return changed();
    return;
  }
  const guide = one(guides);
  const output = (name: string) =>
    one(
      ports(anchor, "outputs")
        .map((port, slot) => ({ port, slot }))
        .filter((row) => row.port.name === name),
    ).slot;
  const positiveSlot = output("positive"),
    latentSlot = output("LATENT");
  const nativeVae = incoming(nodes, edges, anchor, "vae"),
    guideVae = incoming(nodes, edges, guide, "vae");
  const positive = incoming(nodes, edges, guide, "positive");
  if (
    !frame("last_frame", guide, "image") ||
    !matches(positive, String(anchor.id), positiveSlot) ||
    !matches(
      incoming(nodes, edges, guide, "latent"),
      String(anchor.id),
      latentSlot,
    ) ||
    nativeVae === undefined ||
    guideVae === undefined ||
    !matches(guideVae, nativeVae.originId, nativeVae.originSlot) ||
    !Array.isArray(guide.widgets_values) ||
    guide.widgets_values[0] !==
      (24 * inputs.duration_milliseconds) / 1000 - 1 ||
    !edges.some(
      (edge) => edge.originId === String(guide.id) && edge.originSlot === 0,
    ) ||
    edges.some(
      (edge) =>
        edge.originId === String(anchor.id) &&
        edge.originSlot === positiveSlot &&
        edge.id !== positive?.id,
    )
  )
    return changed();
}

/** Ignore layout and host slot ordering, but include added/removed media edges and private definition wiring. */
export function preparedSequenceGraphFingerprint(
  value: unknown,
  anchorNodeId: number,
  ids: SpliceMediaIds,
): string {
  const { roots, instance, rootEdges, definition, nodes, edges } = scope(
    value,
    anchorNodeId,
  );
  const selected = new Set(
    [
      anchorNodeId,
      ids.firstFrame,
      ids.lastFrame,
      ids.geometryDonor,
      ...Object.values(ids.retainedCrops ?? {}).map((row) => row.nodeId),
    ]
      .filter((id) => id !== undefined)
      .map(String),
  );
  for (const node of roots)
    if (
      node.type === I2VA_SCALE_NODE_TYPE ||
      node.type === I2VA_SIZE_NODE_TYPE ||
      node.type === "MiniMaxH3AddGuide"
    )
      selected.add(String(node.id));
  const widgets = (node: Node): unknown => {
    if (!mediaTypes.has(String(node.type))) return null;
    const values = Array.isArray(node.widgets_values)
      ? node.widgets_values
      : [];
    if (node.type === "ImageCropV2") {
      const region = record(values[0]);
      return ["x", "y", "width", "height"].map((key) => region?.[key] ?? null);
    }
    return node.type === I2VA_SCALE_NODE_TYPE
      ? values.slice(0, 3)
      : values.slice(0, 1);
  };
  const projection = (
    nodes: Node[],
    edges: SerializedEdge[],
    selected?: ReadonlySet<string>,
    boundary?: Node,
  ) => {
    const byId = new Map(nodes.map((node) => [String(node.id), node]));
    const name = (
      id: string,
      direction: "inputs" | "outputs",
      slot: number,
    ) => {
      if (id === "-10") return rows(boundary?.inputs)[slot]?.name ?? null;
      if (id === "-20") return rows(boundary?.outputs)[slot]?.name ?? null;
      const node = byId.get(id);
      return node === undefined
        ? null
        : (ports(node, direction)[slot]?.name ?? null);
    };
    return {
      nodes: nodes
        .filter(
          (node) => selected === undefined || selected.has(String(node.id)),
        )
        .map((node) => ({
          id: String(node.id),
          type: node.type,
          mode: node.mode ?? 0,
          widgets: widgets(node),
          inputs: ports(node, "inputs")
            .filter((port) => port.link !== null && port.link !== undefined)
            .map((port) => [port.name, port.link])
            .sort((left, right) =>
              String(left[0]).localeCompare(String(right[0])),
            ),
          outputs: ports(node, "outputs")
            .filter((port) => Array.isArray(port.links) && port.links.length)
            .map((port) => [port.name, [...(port.links as unknown[])].sort()])
            .sort((left, right) =>
              String(left[0]).localeCompare(String(right[0])),
            ),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      edges: edges
        .filter(
          (edge) =>
            selected === undefined ||
            selected.has(edge.originId) ||
            selected.has(edge.targetId),
        )
        .map((edge) => [
          edge.id,
          edge.originId,
          name(edge.originId, "outputs", edge.originSlot),
          edge.targetId,
          name(edge.targetId, "inputs", edge.targetSlot),
          edge.type,
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    };
  };
  // CRITICAL: owned graph identity omits media widgets and nested guide definitions.
  // Keep this extra identity volatile and recheck after every source await and before queue.
  return sha256Text(
    JSON.stringify({
      instance: instance.type,
      root: projection(roots, rootEdges, selected),
      privateDefinition:
        definition === undefined
          ? null
          : projection(nodes, edges, undefined, definition),
    }),
  );
}

/** Preserve a typed local refusal across the controller's rollback classifiers. */
export function createPreparedSequenceGraphGuard(
  value: unknown,
  anchorNodeId: number,
  ids: SpliceMediaIds,
  inputs: AppModeInputs,
): (
  current: unknown,
  boundary?: SequenceFailureAttribution["boundary"],
) => void {
  const observe = (
    current: unknown,
    boundary: SequenceFailureAttribution["boundary"],
  ) => {
    try {
      assertVisibleSequenceFrames(current, anchorNodeId, ids, inputs);
      return preparedSequenceGraphFingerprint(current, anchorNodeId, ids);
    } catch {
      throw new AppModeError(
        "sequence_media_changed",
        "reselect the declared frame source and retry the sequence",
        undefined,
        undefined,
        undefined,
        {
          origin: "visible-guide",
          boundary,
          managedAction: "unattributed",
          httpStatusClass: "unattributed",
        },
      );
    }
  };
  const fingerprint = observe(value, "materialize");
  return (current, boundary = "materialize") => {
    if (observe(current, boundary) !== fingerprint)
      throw new AppModeError(
        "sequence_media_changed",
        "reselect the declared frame source and retry the sequence",
        undefined,
        undefined,
        undefined,
        {
          origin: "candidate-graph",
          boundary,
          managedAction: "unattributed",
          httpStatusClass: "unattributed",
        },
      );
  };
}
