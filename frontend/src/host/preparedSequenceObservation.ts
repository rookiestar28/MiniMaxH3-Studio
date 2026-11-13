/** Fresh source receipts for one owned child, with no locator-bearing observation wire. */
import {
  compiledOutputNodes,
  graphNodes,
  isLink,
  record,
  type AppModeCompiledPrompt,
  type AppModeInputs,
} from "./appModeContract";
import { H3_NODE_TYPES } from "./graphAdapter";
import {
  resolvePreparedSequenceSpliceMedia,
  type PreparedSequenceMedia,
} from "./preparedSequenceMedia";
import {
  observeSequenceMediaBlueprints,
  sequenceMediaBlueprint,
  type SequenceMediaObserver,
} from "./sequenceMediaCapture";
import {
  sequenceMediaBindingFingerprint,
  SequenceMediaBindingError,
} from "./sequenceMediaBindings";
import {
  FRAME_BINDINGS,
  I2VA_SCALE_NODE_TYPE,
  I2VA_SIZE_NODE_TYPE,
  I2VA_SCALE_WIDGET_VALUES,
  type SpliceMediaIds,
} from "./templateGraphTopology";
import {
  assertVisibleSequenceFrames,
  preparedSequenceGraphFingerprint,
} from "./preparedSequenceGraph";

export type SequenceMediaSourceObservation = Readonly<{
  source_identities: readonly Readonly<{
    asset_id: string;
    role: "first_frame" | "last_frame";
    receipt_handle: string;
    source_fingerprint: string;
  }>[];
  media_binding_fingerprint: string | null;
}>;
const changed = (): never => {
  throw new SequenceMediaBindingError("sequence_media_changed", {
    origin: "compiled-guide",
    boundary: "source-observe",
    managedAction: "unattributed",
    httpStatusClass: "unattributed",
  });
};
const unavailable = (): never => {
  throw new SequenceMediaBindingError("sequence_media_unavailable");
};
const one = <T>(rows: readonly T[]): T =>
  rows.length === 1 ? rows[0]! : changed();
const link = (
  value: unknown,
  id: string | number | undefined,
  slot = 0,
): boolean =>
  id !== undefined &&
  isLink(value) &&
  String(value[0]) === String(id) &&
  value[1] === slot;
const sameLink = (left: unknown, right: unknown): boolean =>
  isLink(right) && link(left, String(right[0]), right[1]);
const endpoint = (ids: SpliceMediaIds, loader: number | undefined) =>
  loader === undefined
    ? undefined
    : (ids.retainedCrops?.[String(loader)]?.nodeId ?? loader);

export function preparedSequenceExecutionSources(
  compiled: AppModeCompiledPrompt,
  ids: SpliceMediaIds,
  inputs: AppModeInputs,
) {
  const nodes = compiledOutputNodes(compiled);
  const anchor = one(
    nodes.filter(({ node }) => node.class_type === "MiniMaxH3ImageToVideo"),
  );
  const native = record(anchor.node.inputs) ?? changed();
  const roles = FRAME_BINDINGS[inputs.task_mode] ?? changed();
  const first = roles.includes("first_frame")
    ? endpoint(ids, ids.firstFrame)
    : undefined;
  if (
    (first === undefined
      ? native.first_frame !== undefined
      : !link(native.first_frame, first)) ||
    native.last_frame !== undefined
  )
    return changed();
  const guides = nodes.filter(
    ({ node }) => node.class_type === "MiniMaxH3AddGuide",
  );
  if (!roles.includes("last_frame")) {
    if (guides.length) return changed();
  } else {
    const guide = one(guides),
      last = endpoint(ids, ids.lastFrame);
    const guideInputs = record(guide.node.inputs) ?? changed();
    if (
      !link(guideInputs.image, last) ||
      !link(guideInputs.positive, anchor.id, 0) ||
      !link(guideInputs.latent, anchor.id, 1) ||
      !sameLink(guideInputs.vae, native.vae) ||
      guideInputs.frame_idx !==
        (24 * inputs.duration_milliseconds) / 1000 - 1 ||
      !nodes.some(({ node }) =>
        Object.values(record(node.inputs) ?? {}).some((value) =>
          link(value, guide.id),
        ),
      )
    )
      return changed();
    // CRITICAL: retaining any native positive consumer bypasses the closing guide.
    if (
      nodes.some(
        ({ id, node }) =>
          id !== guide.id &&
          Object.values(record(node.inputs) ?? {}).some((value) =>
            link(value, anchor.id, 0),
          ),
      )
    )
      return changed();
  }
  return { nodes, native };
}

export async function observePreparedSequenceMedia(
  visibleGraph: unknown,
  compiled: AppModeCompiledPrompt,
  ids: SpliceMediaIds,
  inputs: AppModeInputs,
  prepared: PreparedSequenceMedia,
  observe: SequenceMediaObserver,
  currentGraph?: Readonly<{ anchorNodeId: number; readGraph: () => unknown }>,
): Promise<SequenceMediaSourceObservation> {
  resolvePreparedSequenceSpliceMedia(inputs, prepared);
  if (currentGraph !== undefined)
    assertVisibleSequenceFrames(
      visibleGraph,
      currentGraph.anchorNodeId,
      ids,
      inputs,
    );
  const visibleFingerprint =
    currentGraph === undefined
      ? undefined
      : preparedSequenceGraphFingerprint(
          visibleGraph,
          currentGraph.anchorNodeId,
          ids,
        );
  const { nodes, native } = preparedSequenceExecutionSources(
    compiled,
    ids,
    inputs,
  );
  const entries = prepared.bindings?.entries ?? [];
  const roleRows = entries.filter((entry) =>
    (FRAME_BINDINGS[inputs.task_mode] ?? []).includes(
      entry.role as "first_frame" | "last_frame",
    ),
  );
  let sources: ReturnType<typeof sequenceMediaBlueprint> = [];
  if (roleRows.length) {
    const registry = one(
      nodes.filter(
        ({ node }) => node.class_type === H3_NODE_TYPES.referenceRegistry,
      ),
    );
    sources = sequenceMediaBlueprint(
      visibleGraph,
      compiled,
      registry.id,
      roleRows,
    );
  }
  if (prepared.sequenceTaskMode === "i2va") {
    const scale = one(
      nodes.filter(({ node }) => node.class_type === I2VA_SCALE_NODE_TYPE),
    );
    const size = one(
      nodes.filter(({ node }) => node.class_type === I2VA_SIZE_NODE_TYPE),
    );
    const scaleInputs = record(scale.node.inputs) ?? changed(),
      sizeInputs = record(size.node.inputs) ?? changed();
    const donor = endpoint(ids, ids.firstFrame ?? ids.geometryDonor);
    const scaleSeen = one(
      graphNodes(visibleGraph)
        .map(record)
        .filter((row) => row !== undefined && String(row.id) === scale.id),
    )!;
    if (
      !link(scaleInputs.image, donor) ||
      !link(sizeInputs.image, scale.id) ||
      !link(native.width, size.id, 0) ||
      !link(native.height, size.id, 1) ||
      scaleInputs.upscale_method !== I2VA_SCALE_WIDGET_VALUES[0] ||
      scaleInputs.megapixels !== I2VA_SCALE_WIDGET_VALUES[1] ||
      scaleInputs.resolution_steps !== I2VA_SCALE_WIDGET_VALUES[2] ||
      JSON.stringify(scaleSeen.widgets_values) !==
        JSON.stringify(I2VA_SCALE_WIDGET_VALUES)
    )
      return changed();
    if (inputs.task_mode === "t2va") {
      if (
        roleRows.length ||
        nodes.some(
          ({ node }) => node.class_type === H3_NODE_TYPES.referenceRegistry,
        )
      )
        return changed();
      sources = sequenceMediaBlueprint(
        visibleGraph,
        compiled,
        scale.id,
        entries,
        I2VA_SCALE_NODE_TYPE,
        "image",
      );
    }
  }
  if (sources.length !== entries.length) return changed();
  // CRITICAL: node IDs are remapped by materialization. Prove the exact new owned IDs
  // and all retained source/crop semantics before observing any one-shot receipt.
  for (const expected of entries) {
    const actual =
      sources.find((row) => row.asset_id === expected.asset_id) ??
      unavailable();
    const loaderId =
      expected.role === "first_frame"
        ? (ids.firstFrame ?? ids.geometryDonor)
        : ids.lastFrame;
    const crop =
      loaderId === undefined
        ? undefined
        : ids.retainedCrops?.[String(loaderId)];
    if (
      actual.loader_node_id !== String(loaderId) ||
      actual.registry_endpoint.source_node_id !==
        String(endpoint(ids, loaderId)) ||
      actual.locator !== expected.locator ||
      actual.role !== expected.role ||
      actual.loader_class !== expected.loader_class ||
      (expected.transform === null
        ? actual.transform !== null || crop !== undefined
        : actual.transform === null ||
          actual.transform.node_id !== String(crop?.nodeId) ||
          ["x", "y", "width", "height"].some(
            (key) =>
              actual.transform!.region[
                key as keyof typeof actual.transform.region
              ] !==
              expected.transform!.region[
                key as keyof typeof expected.transform.region
              ],
          ))
    )
      throw new SequenceMediaBindingError("sequence_media_changed", {
        origin: "retained-binding",
        boundary: "source-observe",
        managedAction: "unattributed",
        httpStatusClass: "unattributed",
      });
  }
  if (!sources.length)
    return Object.freeze({
      source_identities: [],
      media_binding_fingerprint: null,
    });
  const renewed = await observeSequenceMediaBlueprints(sources, observe);
  if (
    currentGraph !== undefined &&
    preparedSequenceGraphFingerprint(
      currentGraph.readGraph(),
      currentGraph.anchorNodeId,
      ids,
    ) !== visibleFingerprint
  )
    throw new SequenceMediaBindingError("sequence_media_changed", {
      origin: "observation-graph",
      boundary: "source-observe",
      managedAction: "unattributed",
      httpStatusClass: "unattributed",
    });
  if (
    renewed.entries.some(
      (row) =>
        row.source_identity.source_fingerprint !==
        entries.find((entry) => entry.asset_id === row.asset_id)
          ?.source_identity.source_fingerprint,
    )
  )
    throw new SequenceMediaBindingError("sequence_media_changed", {
      origin: "renewed-source",
      boundary: "source-observe",
      managedAction: "unattributed",
      httpStatusClass: "unattributed",
    });
  return Object.freeze({
    source_identities: Object.freeze(
      renewed.entries.map((row) =>
        Object.freeze({
          asset_id: row.asset_id,
          role: row.role as "first_frame" | "last_frame",
          receipt_handle: row.source_identity.receipt_handle,
          source_fingerprint: row.source_identity.source_fingerprint,
        }),
      ),
    ),
    media_binding_fingerprint: sequenceMediaBindingFingerprint(
      prepared.bindings!,
    ),
  });
}
