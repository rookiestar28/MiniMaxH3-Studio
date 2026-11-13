// App Mode managed preparation: the Production-managed preflight, source identity request
// and execution projection ( split).

import { sha256Text } from "../contracts/canonicalFingerprint";
import { IMAGE_CROP_NODE_TYPE } from "./imageCropCapability";
import { isLoaderBoundImageCrop } from "./imageCropBindings";
import type { SequenceMediaSourceObservation } from "./preparedSequenceObservation";
import {
  INPUT_GEOMETRY_RECEIPT_SCHEMA,
  INPUT_GEOMETRY_REQUEST_SCHEMA,
  type InputGeometryReceipt,
  type InputGeometryRequest,
} from "./inputGeometry";
import type { OwnedGraphObservation } from "./ownedGraphIdentity";
import { cloneCompiledPromptData } from "./compiledPromptData";
import { cloneQueueEnvelope } from "./queueSeam";
import { existingCompiledProjection } from "./appModeCensus";
import {
  type AppModeCompiledPrompt,
  AppModeError,
  type AppModeInputs,
  auditOverrideNodeType,
  compiledOutputNodes,
  compilerNodeType,
  contentFreeBootstrapWorkflow,
  type ExistingCompiledAdmission,
  fingerprint,
  getVideoComponentsNodeType,
  graphNodes,
  imageGenerationNodeType,
  isLink,
  isSafeCompiledPromptEnvelope,
  loadAudioNodeType,
  loadImageNodeType,
  loadVideoNodeType,
  type ManagedAppModeExecutionProjector,
  type ManagedAppModePreflight,
  nativeAdapterNodeType,
  planNodeType,
  PREPARED_GRAPH_OBSERVATION_SCHEMA,
  SEQUENCE_PREPARED_GRAPH_OBSERVATION_SCHEMA,
  type PreparedGraphObservation,
  productShellNodeType,
  record,
  referenceGenerationNodeType,
  referenceRegistryNodeType,
  requestNodeType,
  SOURCE_IMAGE_CHANGED_REASON,
  validatorNodeType,
} from "./appModeContract";
import {
  floatPrimitiveNodeType,
  serializedWidgetValues,
} from "./appModeTemplateSources";

export function projectManagedExecutionPrompt(
  source: AppModeCompiledPrompt,
  projector?: ManagedAppModeExecutionProjector,
): AppModeCompiledPrompt {
  if (projector === undefined) return source;
  let sourceFingerprint: string;
  let isolated: AppModeCompiledPrompt | undefined;
  try {
    sourceFingerprint = fingerprint(source);
    isolated = cloneQueueEnvelope(source);
  } catch {
    throw new AppModeError(
      "compile_failed",
      "the managed execution source could not be isolated",
    );
  }
  if (isolated === undefined)
    throw new AppModeError(
      "compile_failed",
      "the managed execution source could not be isolated",
    );
  let projected: AppModeCompiledPrompt;
  try {
    projected = projector(isolated);
  } catch (error) {
    if (error instanceof AppModeError) throw error;
    throw new AppModeError(
      "compile_failed",
      "the managed execution projection was rejected",
    );
  }
  // CRITICAL: projection precedes every managed fingerprint. Never hand the projector the source
  // object or move this behind queuePrompt; either change breaks execution-identity equality.
  if (
    fingerprint(source) !== sourceFingerprint ||
    !isSafeCompiledPromptEnvelope(projected)
  )
    throw new AppModeError(
      "compile_failed",
      "the managed execution projection is not a stable prompt envelope",
    );
  compiledOutputNodes(projected);
  const result = cloneQueueEnvelope(projected);
  if (result === undefined)
    throw new AppModeError(
      "compile_failed",
      "the managed execution projection could not be isolated",
    );
  return result;
}

function compiledInputLinks(node: Record<string, unknown>): string[] {
  const inputs = record(node.inputs);
  if (inputs === undefined) return [];
  const ids: string[] = [];
  for (const value of Object.values(inputs)) {
    if (isLink(value)) ids.push(String(value[0]));
    else if (Array.isArray(value))
      for (const entry of value) if (isLink(entry)) ids.push(String(entry[0]));
  }
  return ids;
}

const managedBootstrapNodeTypes = new Set<string>([
  requestNodeType,
  planNodeType,
  compilerNodeType,
  auditOverrideNodeType,
  validatorNodeType,
  nativeAdapterNodeType,
  productShellNodeType,
  referenceRegistryNodeType,
  loadImageNodeType,
  loadVideoNodeType,
  loadAudioNodeType,
  getVideoComponentsNodeType,
  floatPrimitiveNodeType,
  "PrimitiveInt",
]);

// IMPORTANT: a single-clip bootstrap admits the native crop node only on the existing route
// and only as a one-hop interposer over a loader (exactly `image` and `crop_region`, the image
// from a LoadImage at slot 0, a bounded region). Do not add the crop type to
// managedBootstrapNodeTypes or to a single clip's bootstrapTypes instead: that admits it on the
// connect, new and replace routes, and drops crop nodes from model_fingerprint, which is
// computed outside the bootstrap type set.
function isExistingCanvasImageCrop(
  node: Record<string, unknown>,
  byId: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
  const inputs = record(node.inputs);
  return (
    node.class_type === IMAGE_CROP_NODE_TYPE &&
    inputs !== undefined &&
    Object.keys(inputs).sort().join(",") === "crop_region,image" &&
    isLoaderBoundImageCrop(node, byId)
  );
}

function contentFreeInputIdentity(
  value: unknown,
  byId: ReadonlyMap<string, Record<string, unknown>>,
  depth = 0,
): unknown {
  if (depth > 12)
    throw new AppModeError(
      "compile_failed",
      "the prepared graph identity exceeded its bound",
    );
  if (isLink(value)) {
    const source = byId.get(String(value[0]));
    return ["link", source?.class_type ?? "unknown", value[1]];
  }
  if (Array.isArray(value))
    return value.map((item) => contentFreeInputIdentity(item, byId, depth + 1));
  if (typeof value === "string") return ["text_digest", sha256Text(value)];
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  const object = record(value);
  if (object === undefined)
    throw new AppModeError(
      "compile_failed",
      "the prepared graph identity was not content-free",
    );
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [
        key,
        contentFreeInputIdentity(object[key], byId, depth + 1),
      ]),
  );
}

function exactRecordKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

/**
 * Read only the operator-selected visible LoadImage locator. Scale/size topology
 * is host execution state and is deliberately outside managed admission.
 */
export function buildManagedSourceIdentityRequest(
  visibleGraph: unknown,
  selectedNodeId: string,
): InputGeometryRequest {
  const matches = graphNodes(visibleGraph).filter((value) => {
    const node = record(value);
    return (
      node?.type === loadImageNodeType && String(node.id) === selectedNodeId
    );
  });
  const widgets = serializedWidgetValues(record(matches[0])?.widgets_values);
  const locator = widgets?.[0];
  if (matches.length !== 1 || typeof locator !== "string")
    throw new AppModeError(
      "incompatible_graph",
      "the selected source image is no longer available on the visible canvas",
      SOURCE_IMAGE_CHANGED_REASON,
    );
  return Object.freeze({
    schema: INPUT_GEOMETRY_REQUEST_SCHEMA,
    locator,
  });
}

function validatedSourceIdentity(
  value: InputGeometryReceipt | undefined,
): InputGeometryReceipt {
  const wire = record(value);
  if (
    wire === undefined ||
    !exactRecordKeys(wire, [
      "schema",
      "receipt_handle",
      "source_fingerprint",
    ]) ||
    wire.schema !== INPUT_GEOMETRY_RECEIPT_SCHEMA ||
    typeof wire.receipt_handle !== "string" ||
    !/^ig_[A-Za-z0-9_-]{32,96}$/.test(wire.receipt_handle) ||
    typeof wire.source_fingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(wire.source_fingerprint)
  )
    throw new AppModeError(
      "incompatible_seam",
      "the source identity receipt was unavailable; reselect the image or use native nodes",
      SOURCE_IMAGE_CHANGED_REASON,
    );
  return Object.freeze({
    schema: INPUT_GEOMETRY_RECEIPT_SCHEMA,
    receipt_handle: wire.receipt_handle,
    source_fingerprint: wire.source_fingerprint,
  });
}

/**
 * Freeze the content-free identities needed by the managed Production bridge.
 *
 * The retained bootstrap is a strict backward closure from exactly one
 * ProductShell output. The actual single model submission uses only its fresh,
 * valid, content-free workflow envelope as history metadata; compatible prompt
 * handlers therefore never receive the native canvas.
 */
function validatedSequenceSources(
  value: SequenceMediaSourceObservation,
): SequenceMediaSourceObservation {
  const invalid = (): never => {
    throw new AppModeError(
      "invalid_request",
      "invalid sequence source observation",
    );
  };
  const wire = record(value);
  if (
    wire === undefined ||
    !exactRecordKeys(wire, [
      "source_identities",
      "media_binding_fingerprint",
    ]) ||
    !Array.isArray(wire.source_identities) ||
    wire.source_identities.length > 3 ||
    (wire.source_identities.length
      ? typeof wire.media_binding_fingerprint !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(wire.media_binding_fingerprint)
      : wire.media_binding_fingerprint !== null)
  )
    return invalid();
  const rows = wire.source_identities.map((value) => {
    const row = record(value);
    // IMPORTANT: regex coerces undefined and numbers into valid-looking asset IDs.
    // Require exact own keys and string types before testing the closed V5 row.
    if (
      row === undefined ||
      !exactRecordKeys(row, [
        "asset_id",
        "role",
        "receipt_handle",
        "source_fingerprint",
      ]) ||
      typeof row.asset_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.asset_id) ||
      (row.role !== "first_frame" && row.role !== "last_frame") ||
      typeof row.receipt_handle !== "string" ||
      typeof row.source_fingerprint !== "string"
    )
      return invalid();
    const receipt = validatedSourceIdentity({
      schema: INPUT_GEOMETRY_RECEIPT_SCHEMA,
      receipt_handle: row.receipt_handle,
      source_fingerprint: row.source_fingerprint,
    });
    return Object.freeze({
      asset_id: row.asset_id,
      role: row.role,
      receipt_handle: receipt.receipt_handle,
      source_fingerprint: receipt.source_fingerprint,
    });
  });
  if (
    new Set(rows.map((row) => row.asset_id)).size !== rows.length ||
    new Set(rows.map((row) => row.role)).size !== rows.length
  )
    return invalid();
  return Object.freeze({
    source_identities: Object.freeze(rows),
    media_binding_fingerprint: value.media_binding_fingerprint,
  });
}

export function buildManagedAppModePreparation(
  completeCompiled: AppModeCompiledPrompt,
  inputs: AppModeInputs,
  route: "new" | "replace" | "existing",
  graphFingerprintValue: string,
  ownedGraph: OwnedGraphObservation,
  sourceIdentityReceipt?: InputGeometryReceipt,
  existingSubject?: ExistingCompiledAdmission,
  projectManagedExecution?: ManagedAppModeExecutionProjector,
  sequenceSources?: SequenceMediaSourceObservation,
): ManagedAppModePreflight {
  if (
    sequenceSources !== undefined &&
    (route === "existing" || sourceIdentityReceipt !== undefined)
  )
    throw new AppModeError(
      "invalid_request",
      "sequence sources require private prepared materialization",
    );
  const sequenceMedia =
    sequenceSources === undefined
      ? undefined
      : validatedSequenceSources(sequenceSources);
  const bootstrapTypes = new Set(managedBootstrapNodeTypes);
  if (sequenceMedia !== undefined) bootstrapTypes.add(IMAGE_CROP_NODE_TYPE);
  const admitsCanvasCrops = sequenceMedia === undefined && route === "existing";
  if (!/^sha256:[0-9a-f]{64}$/.test(graphFingerprintValue))
    throw new AppModeError(
      "compile_failed",
      "the prepared visible graph identity is unavailable",
    );
  if (!/^sha256:[0-9a-f]{64}$/.test(ownedGraph.fingerprint))
    throw new AppModeError(
      "compile_failed",
      "the prepared owned graph identity is unavailable",
    );
  const compiled = projectManagedExecutionPrompt(
    completeCompiled,
    projectManagedExecution,
  );
  const completeNodes = compiledOutputNodes(completeCompiled);
  const nodes = compiledOutputNodes(compiled);
  const byId = new Map(nodes.map(({ id, node }) => [id, node] as const));
  let productShell: { id: string; node: Record<string, unknown> } | undefined;
  let anchor: { id: string; node: Record<string, unknown> } | undefined;
  if (route === "existing" && existingSubject !== undefined) {
    const projection = existingCompiledProjection(
      completeNodes,
      existingSubject,
    );
    if (projection !== undefined) {
      productShell = {
        id: existingSubject.productShellNodeId,
        node: projection.productShell,
      };
      anchor = {
        id: existingSubject.anchorNodeId,
        node: projection.anchor,
      };
    }
  } else {
    const productShells = completeNodes.filter(
      ({ node }) => node.class_type === productShellNodeType,
    );
    const anchors = completeNodes.filter(
      ({ node }) =>
        node.class_type === imageGenerationNodeType ||
        node.class_type === referenceGenerationNodeType,
    );
    if (productShells.length === 1 && anchors.length === 1) {
      productShell = productShells[0];
      anchor = anchors[0];
    }
  }
  if (productShell === undefined || anchor === undefined)
    throw new AppModeError(
      "compile_failed",
      "the managed graph has ambiguous execution ownership",
    );

  const closure = new Set<string>();
  const pending = [productShell.id];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (closure.has(id)) continue;
    const node = byId.get(id);
    if (
      node === undefined ||
      typeof node.class_type !== "string" ||
      (!bootstrapTypes.has(node.class_type) &&
        !(admitsCanvasCrops && isExistingCanvasImageCrop(node, byId)))
    )
      throw new AppModeError(
        "compile_failed",
        "the Product Shell bootstrap contains an unmanaged dependency",
      );
    closure.add(id);
    for (const dependency of compiledInputLinks(node)) pending.push(dependency);
    if (closure.size > 128)
      throw new AppModeError(
        "compile_failed",
        "the Product Shell bootstrap exceeded its node bound",
      );
  }
  let bootstrapOutput: Record<string, Record<string, unknown>>;
  try {
    bootstrapOutput = Object.fromEntries(
      nodes
        .filter(({ id }) => closure.has(id))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, node }) => {
          // CRITICAL: the bootstrap queue is host-owned and may normalize its payload. Sharing
          // nested nodes here would mutate the already-fingerprinted full model prompt.
          // Preserve structuredClone first; its data-only fallback admits native widget proxies.
          const isolated = cloneCompiledPromptData(node);
          if (isolated === undefined)
            throw new Error("bootstrap isolation failed");
          return [id, isolated];
        }),
    );
  } catch {
    throw new AppModeError(
      "compile_failed",
      "the Product Shell bootstrap could not be isolated from the model prompt",
    );
  }
  for (const node of Object.values(bootstrapOutput))
    if (compiledInputLinks(node).some((dependency) => !closure.has(dependency)))
      throw new AppModeError(
        "compile_failed",
        "the Product Shell bootstrap contains a dangling dependency",
      );

  let sourceIdentity: InputGeometryReceipt | null = null;
  if (
    sequenceMedia === undefined &&
    route !== "existing" &&
    inputs.task_mode === "i2va"
  ) {
    sourceIdentity = validatedSourceIdentity(sourceIdentityReceipt);
  } else if (route !== "existing" && sourceIdentityReceipt !== undefined)
    throw new AppModeError(
      "invalid_request",
      "source identity is valid only for I2VA",
    );

  const contextTypes = bootstrapTypes;
  const modelIdentity = completeNodes
    .filter(({ node }) => !contextTypes.has(String(node.class_type)))
    .map(({ id, node }) => ({
      id,
      class_type: node.class_type,
      inputs: contentFreeInputIdentity(record(node.inputs) ?? {}, byId),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const compiledPromptFingerprint = fingerprint(compiled);
  const observation = Object.freeze({
    schema:
      sequenceMedia === undefined
        ? PREPARED_GRAPH_OBSERVATION_SCHEMA
        : SEQUENCE_PREPARED_GRAPH_OBSERVATION_SCHEMA,
    route,
    graph_fingerprint: graphFingerprintValue,
    compiled_prompt_fingerprint: compiledPromptFingerprint,
    owned_projection_fingerprint: ownedGraph.fingerprint,
    owned_node_ids: ownedGraph.nodeIds,
    owned_link_ids: ownedGraph.linkIds,
    model_fingerprint: fingerprint({
      schema: "h3.context.prepared_model_identity.v1",
      nodes: modelIdentity,
    }),
    runtime_fingerprint: fingerprint({
      schema:
        sequenceMedia === undefined
          ? "h3.context.prepared_runtime_identity.v1"
          : "h3.context.prepared_runtime_identity.v2",
      route,
      node_types: completeNodes.map(({ node }) => node.class_type).sort(),
      product_shell_node_id: productShell.id,
      native_anchor_node_id: anchor.id,
      fingerprint_domain: "output_producing_graph",
      ...(sequenceMedia === undefined
        ? { source_identity_present: sourceIdentity !== null }
        : {
            media_binding_fingerprint: sequenceMedia.media_binding_fingerprint,
          }),
    }),
    fingerprint_domain: "output_producing_graph",
    expected_frames: inputs.frame_count,
    ...(sequenceMedia === undefined
      ? { source_identity: sourceIdentity }
      : sequenceMedia),
    timeout_ms: 3_600_000,
    native_anchor_node_id: anchor.id,
  }) as PreparedGraphObservation;
  return Object.freeze({
    bootstrap: Object.freeze({
      output: bootstrapOutput,
      workflow: contentFreeBootstrapWorkflow(),
    }),
    observation,
    productShellNodeId: productShell.id,
    nativeAnchorNodeId: anchor.id,
  });
}

export function browserAcceptanceManagedExecutionProjector():
  ManagedAppModeExecutionProjector | undefined {
  const runtime = globalThis as typeof globalThis & {
    __h3M2508ManagedExecutionProjection?: unknown;
  };
  const projector = runtime.__h3M2508ManagedExecutionProjection;
  // CRITICAL: this active E2E seam is automation-only and never comes from workflow/config data.
  // Removing the webdriver guard would let a normal browser silently replace native execution.
  return globalThis.navigator?.webdriver === true &&
    typeof projector === "function"
    ? (projector as ManagedAppModeExecutionProjector)
    : undefined;
}
