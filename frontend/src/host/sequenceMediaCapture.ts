/** Exact declared Registry image binding. Private locators never enter product projections. */
import {
  compiledOutputNodes,
  graphNodes,
  isLink,
  record,
  type AppModeCompiledPrompt,
} from "./appModeContract";
import { H3_NODE_TYPES } from "./graphAdapter";
import { IMAGE_CROP_NODE_TYPE } from "./imageCropCapability";
import {
  INPUT_GEOMETRY_REQUEST_SCHEMA,
  InputGeometryClientError,
  isSafeInputLocator,
  type InputGeometryRequest,
  type InputGeometryReceipt,
} from "./inputGeometry";
import {
  decodeSequenceMediaBindingSet,
  sequenceMediaBindingFingerprint,
  SequenceMediaBindingError,
  SEQUENCE_MEDIA_BINDING_SET_SCHEMA,
  type SequenceMediaBinding,
  type SequenceMediaBindingSet,
} from "./sequenceMediaBindings";

export type SequenceMediaAsset = Readonly<{
  asset_id: string;
  role: string;
  kind: string;
}>;
export type SequenceMediaObserver = (
  request: InputGeometryRequest,
) => Promise<InputGeometryReceipt>;
const changed = (): never => {
  throw new SequenceMediaBindingError("sequence_media_changed", {
    origin: "blueprint",
    boundary: "source-observe",
    managedAction: "unattributed",
    httpStatusClass: "unattributed",
  });
};
const unavailable = (): never => {
  throw new SequenceMediaBindingError("sequence_media_unavailable");
};

export function sequenceMediaBlueprint(
  visibleGraph: unknown,
  compiledGraph: AppModeCompiledPrompt,
  registryNodeId: string,
  assets: readonly SequenceMediaAsset[],
  consumerType: string = H3_NODE_TYPES.referenceRegistry,
  inputName?: string,
) {
  const rows = graphNodes(visibleGraph).map(record);
  const visible = new Map(
    rows
      .filter((row): row is Record<string, unknown> => row !== undefined)
      .map((row) => [String(row.id), row]),
  );
  const compiled = new Map(
    compiledOutputNodes(compiledGraph).map(({ id, node }) => [id, node]),
  );
  const links = record(visibleGraph)?.links;
  if (
    !Array.isArray(links) ||
    visible.size !== rows.length ||
    assets.length < 1 ||
    assets.length > 3 ||
    new Set(assets.map((row) => row.asset_id)).size !== assets.length ||
    new Set(assets.map((row) => row.role)).size !== assets.length
  )
    return changed();
  const node = (id: string, type: string) => {
    const seen = visible.get(id),
      output = compiled.get(id);
    if (seen === undefined || output === undefined) return unavailable();
    if (seen.type !== type || output.class_type !== type) return changed();
    return { seen, inputs: record(output.inputs) ?? changed() };
  };
  const linked = (id: string, input: string, value: unknown): [string, 0] => {
    if (!isLink(value) || value[1] !== 0) return changed();
    const source = String(value[0]);
    const ports = visible.get(id)?.inputs;
    if (!Array.isArray(ports)) return changed();
    const indices = ports
      .map((port, i) => (record(port)?.name === input ? i : -1))
      .filter((i) => i >= 0);
    if (indices.length !== 1) return changed();
    const index = indices[0]!;
    const linkId = record(ports[index])?.link;
    const matching = links.filter(
      (edge) => Array.isArray(edge) && edge[0] === linkId,
    );
    if (matching.length !== 1) return changed();
    const edge = matching[0] as unknown[];
    if (
      edge.length !== 6 ||
      String(edge[1]) !== source ||
      edge[2] !== 0 ||
      String(edge[3]) !== id ||
      edge[4] !== index ||
      edge[5] !== "IMAGE"
    )
      return changed();
    return [source, 0];
  };
  const registry = node(registryNodeId, consumerType);
  return assets.map((asset) => {
    if (
      asset.kind !== "image" ||
      !["first_frame", "last_frame"].includes(asset.role)
    )
      return changed();
    const declaredInput = inputName ?? asset.role;
    const [endpoint] = linked(
      registryNodeId,
      declaredInput,
      registry.inputs[declaredInput],
    );
    const source = compiled.get(endpoint);
    if (source === undefined || visible.get(endpoint) === undefined)
      return unavailable();
    let loaderId = endpoint;
    let transform: SequenceMediaBinding["transform"] = null;
    if (source.class_type === IMAGE_CROP_NODE_TYPE) {
      const crop = node(endpoint, IMAGE_CROP_NODE_TYPE);
      [loaderId] = linked(endpoint, "image", crop.inputs.image);
      const values = crop.seen.widgets_values;
      const region = record(crop.inputs.crop_region);
      const seenRegion = Array.isArray(values) ? record(values[0]) : undefined;
      const keys = ["x", "y", "width", "height"] as const;
      if (
        region === undefined ||
        seenRegion === undefined ||
        Object.keys(region).length !== 4 ||
        Object.keys(seenRegion).length !== 4 ||
        !keys.every(
          (key) =>
            Number.isSafeInteger(region[key]) &&
            region[key] === seenRegion[key],
        )
      )
        return changed();
      transform = {
        node_id: endpoint,
        class_type: IMAGE_CROP_NODE_TYPE,
        region: {
          x: Number(region.x),
          y: Number(region.y),
          width: Number(region.width),
          height: Number(region.height),
        },
      };
    }
    const loader = node(loaderId, "LoadImage");
    const widgets = loader.seen.widgets_values;
    const locator = Array.isArray(widgets) ? widgets[0] : undefined;
    if (!isSafeInputLocator(locator)) return unavailable();
    // CRITICAL: only the Registry-declared visible loader authorizes a private locator.
    // Never substitute a template sample, unrelated loader or compiled-only widget value.
    if (loader.inputs.image !== locator)
      throw new SequenceMediaBindingError("sequence_media_changed", {
        origin: "compiled-locator",
        boundary: "source-observe",
        managedAction: "unattributed",
        httpStatusClass: "unattributed",
      });
    return {
      asset_id: asset.asset_id,
      role: asset.role,
      kind: "image" as const,
      loader_class: "LoadImage" as const,
      loader_node_id: loaderId,
      locator,
      registry_endpoint: {
        node_id: registryNodeId,
        input_name: declaredInput,
        source_node_id: endpoint,
        source_slot: 0 as const,
      },
      transform,
    };
  });
}

export async function captureSequenceMediaBindings(
  visibleGraph: unknown,
  compiledGraph: AppModeCompiledPrompt,
  registryNodeId: string,
  assets: readonly SequenceMediaAsset[],
  observe: SequenceMediaObserver,
): Promise<SequenceMediaBindingSet> {
  return observeSequenceMediaBlueprints(
    sequenceMediaBlueprint(visibleGraph, compiledGraph, registryNodeId, assets),
    observe,
  );
}

export async function observeSequenceMediaBlueprints(
  sources: ReturnType<typeof sequenceMediaBlueprint>,
  observe: SequenceMediaObserver,
): Promise<SequenceMediaBindingSet> {
  const entries: SequenceMediaBinding[] = [];
  for (const source of sources) {
    let identity: InputGeometryReceipt;
    try {
      identity = await observe({
        schema: INPUT_GEOMETRY_REQUEST_SCHEMA,
        locator: source.locator,
      });
    } catch (error) {
      if (
        error instanceof InputGeometryClientError &&
        error.category === "input_changed"
      )
        throw new SequenceMediaBindingError("sequence_media_changed", {
          origin: "renewed-source",
          boundary: "source-observe",
          managedAction: "unattributed",
          httpStatusClass: "unattributed",
        });
      return unavailable();
    }
    entries.push({ ...source, source_identity: identity });
  }
  return decodeSequenceMediaBindingSet({
    schema: SEQUENCE_MEDIA_BINDING_SET_SCHEMA,
    entries,
  });
}

/** Bind Generate to the imported Context's execution node, including the visible Plan edge. */
export async function captureQualifiedSequenceMediaBindings(
  visibleGraph: unknown,
  compiledGraph: AppModeCompiledPrompt,
  productShellNodeId: string,
  assets: readonly SequenceMediaAsset[],
  observe: SequenceMediaObserver,
): Promise<SequenceMediaBindingSet> {
  const visible = new Map(
    graphNodes(visibleGraph).map((value) => {
      const row = record(value) ?? changed();
      return [String(row.id), row] as const;
    }),
  );
  const compiled = new Map(
    compiledOutputNodes(compiledGraph).map(({ id, node }) => [id, node]),
  );
  const links = record(visibleGraph)?.links;
  if (!Array.isArray(links) || visible.size !== graphNodes(visibleGraph).length)
    return changed();
  const follow = (
    targetId: string,
    targetType: string,
    input: string,
    sourceSlot: number,
    sourceType: string,
  ): string => {
    const seen = visible.get(targetId),
      node = compiled.get(targetId);
    if (seen === undefined || node === undefined) return unavailable();
    const inputs = record(node.inputs);
    const value = inputs?.[input];
    if (
      seen.type !== targetType ||
      node.class_type !== targetType ||
      !isLink(value) ||
      value[1] !== sourceSlot ||
      !Array.isArray(seen.inputs)
    )
      return changed();
    const ports = seen.inputs.map(record);
    const indices = ports
      .map((port, i) => (port?.name === input ? i : -1))
      .filter((i) => i >= 0);
    if (indices.length !== 1) return changed();
    const index = indices[0]!;
    const port = ports[index]!;
    const edge = links.filter(
      (edge) => Array.isArray(edge) && edge[0] === port.link,
    );
    if (edge.length !== 1) return changed();
    const row = edge[0] as unknown[];
    const sourceId = String(value[0]);
    if (
      row.length !== 6 ||
      String(row[1]) !== sourceId ||
      row[2] !== sourceSlot ||
      String(row[3]) !== targetId ||
      row[4] !== index ||
      typeof port.type !== "string" ||
      row[5] !== port.type
    )
      return changed();
    if (!visible.has(sourceId) || !compiled.has(sourceId)) return unavailable();
    if (
      visible.get(sourceId)!.type !== sourceType ||
      compiled.get(sourceId)!.class_type !== sourceType
    )
      return changed();
    return sourceId;
  };
  // CRITICAL: never select the first Registry on a canvas. Follow the exact imported
  // ProductShell report and Plan on both visible and compiled graphs before reading a locator.
  const validator = follow(
    productShellNodeId,
    H3_NODE_TYPES.productShell,
    "report",
    1,
    H3_NODE_TYPES.validator,
  );
  const plan = follow(
    validator,
    H3_NODE_TYPES.validator,
    "plan",
    0,
    H3_NODE_TYPES.plan,
  );
  const registry = follow(
    plan,
    H3_NODE_TYPES.plan,
    "reference_registry",
    0,
    H3_NODE_TYPES.referenceRegistry,
  );
  return captureSequenceMediaBindings(
    visibleGraph,
    compiledGraph,
    registry,
    assets,
    observe,
  );
}

export async function reobserveSequenceMediaBindings(
  retained: SequenceMediaBindingSet,
  visibleGraph: unknown,
  compiledGraph: AppModeCompiledPrompt,
  observe: SequenceMediaObserver,
): Promise<SequenceMediaBindingSet> {
  const expected = decodeSequenceMediaBindingSet(retained);
  const registry = expected.entries[0]!.registry_endpoint.node_id;
  if (
    expected.entries.some((row) => row.registry_endpoint.node_id !== registry)
  )
    return changed();
  const renewed = await captureSequenceMediaBindings(
    visibleGraph,
    compiledGraph,
    registry,
    expected.entries,
    observe,
  );
  // IMPORTANT: compare immutable source/endpoint/crop identity, never ephemeral receipt handles.
  if (
    sequenceMediaBindingFingerprint(renewed) !==
    sequenceMediaBindingFingerprint(expected)
  )
    return changed();
  return renewed;
}
