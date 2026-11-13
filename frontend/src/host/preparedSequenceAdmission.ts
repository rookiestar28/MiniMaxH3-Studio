/** Exact private frame topology; ordinary App Mode admission stays unchanged. */
import {
  isLink,
  record,
  type AppModeCompiledPrompt,
  type AppModeInputs,
} from "./appModeContract";
import { H3_NODE_TYPES } from "./graphAdapter";
import { IMAGE_CROP_NODE_TYPE } from "./imageCropCapability";
import {
  resolvePreparedSequenceSpliceMedia,
  type PreparedSequenceMedia,
} from "./preparedSequenceMedia";
import { preparedSequenceExecutionSources } from "./preparedSequenceObservation";
import {
  FRAME_BINDINGS,
  I2VA_SCALE_NODE_TYPE,
  I2VA_SIZE_NODE_TYPE,
  I2VA_SCALE_WIDGET_VALUES,
  type SpliceMediaIds,
} from "./templateGraphTopology";

const linked = (value: unknown, id: string | number | undefined, slot = 0) =>
  id !== undefined &&
  isLink(value) &&
  String(value[0]) === String(id) &&
  value[1] === slot;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function matchesPreparedSequenceMedia(
  compiled: AppModeCompiledPrompt,
  ids: SpliceMediaIds | undefined,
  inputs: AppModeInputs,
  prepared: PreparedSequenceMedia,
): boolean {
  try {
    if (ids === undefined || ids.crops !== undefined) return false;
    resolvePreparedSequenceSpliceMedia(inputs, prepared);
    const { nodes, native } = preparedSequenceExecutionSources(
      compiled,
      ids,
      inputs,
    );
    const byId = new Map(nodes.map((row) => [row.id, row.node]));
    const entries = prepared.bindings?.entries ?? [];
    const roles = FRAME_BINDINGS[inputs.task_mode] ?? [];
    const endpoint = (id: number | undefined) =>
      id === undefined
        ? undefined
        : (ids.retainedCrops?.[String(id)]?.nodeId ?? id);
    if (
      nodes.filter((row) => row.node.class_type === "LoadImage").length !==
        entries.length ||
      nodes.filter((row) => row.node.class_type === IMAGE_CROP_NODE_TYPE)
        .length !== entries.filter((row) => row.transform !== null).length ||
      Object.keys(ids.retainedCrops ?? {}).length !==
        entries.filter((row) => row.transform !== null).length
    )
      return false;
    for (const entry of entries) {
      const loaderId =
        entry.role === "first_frame"
          ? (ids.firstFrame ?? ids.geometryDonor)
          : ids.lastFrame;
      const loader =
        loaderId === undefined ? undefined : byId.get(String(loaderId));
      const loaderInputs = record(loader?.inputs);
      if (
        loader?.class_type !== "LoadImage" ||
        loaderInputs === undefined ||
        !exactKeys(loaderInputs, ["image"]) ||
        loaderInputs.image !== entry.locator
      )
        return false;
      const crop =
        loaderId === undefined
          ? undefined
          : ids.retainedCrops?.[String(loaderId)];
      if (entry.transform === null) {
        if (crop !== undefined) return false;
      } else {
        const node =
          crop === undefined ? undefined : byId.get(String(crop.nodeId));
        const cropInputs = record(node?.inputs),
          region = record(cropInputs?.crop_region);
        if (
          node?.class_type !== IMAGE_CROP_NODE_TYPE ||
          cropInputs === undefined ||
          !exactKeys(cropInputs, ["image", "crop_region"]) ||
          !linked(cropInputs.image, loaderId) ||
          region === undefined ||
          !exactKeys(region, ["x", "y", "width", "height"]) ||
          Object.entries(entry.transform.region).some(
            ([key, value]) =>
              region[key] !== value ||
              crop?.region[key as keyof typeof crop.region] !== value,
          )
        )
          return false;
        // CRITICAL: an extra raw-loader consumer bypasses the retained crop even when Registry agrees.
        if (
          nodes.some(
            ({ id, node }) =>
              id !== String(crop!.nodeId) &&
              Object.values(record(node.inputs) ?? {}).some((value) =>
                linked(value, loaderId),
              ),
          )
        )
          return false;
      }
    }
    const registries = nodes.filter(
      (row) => row.node.class_type === H3_NODE_TYPES.referenceRegistry,
    );
    const registry = record(registries[0]?.node.inputs);
    if (
      registries.length !== (roles.length ? 1 : 0) ||
      (roles.length && (registry === undefined || !exactKeys(registry, roles)))
    )
      return false;
    if (
      roles.includes("first_frame") &&
      !linked(registry?.first_frame, endpoint(ids.firstFrame))
    )
      return false;
    if (
      roles.includes("last_frame") &&
      !linked(registry?.last_frame, endpoint(ids.lastFrame))
    )
      return false;
    const guides = nodes.filter(
      (row) => row.node.class_type === "MiniMaxH3AddGuide",
    );
    if (
      guides.some(
        (row) =>
          !exactKeys(record(row.node.inputs) ?? {}, [
            "positive",
            "vae",
            "latent",
            "image",
            "frame_idx",
          ]),
      )
    )
      return false;
    const scales = nodes.filter(
        (row) => row.node.class_type === I2VA_SCALE_NODE_TYPE,
      ),
      sizes = nodes.filter(
        (row) => row.node.class_type === I2VA_SIZE_NODE_TYPE,
      );
    if (prepared.sequenceTaskMode === "i2va") {
      if (scales.length !== 1 || sizes.length !== 1) return false;
      const scale = record(scales[0]!.node.inputs),
        size = record(sizes[0]!.node.inputs);
      if (
        scale === undefined ||
        !exactKeys(scale, [
          "image",
          "upscale_method",
          "megapixels",
          "resolution_steps",
        ]) ||
        size === undefined ||
        !exactKeys(size, ["image"]) ||
        !linked(scale.image, endpoint(ids.firstFrame ?? ids.geometryDonor)) ||
        !linked(size.image, scales[0]!.id) ||
        !linked(native.width, sizes[0]!.id, 0) ||
        !linked(native.height, sizes[0]!.id, 1) ||
        scale.upscale_method !== I2VA_SCALE_WIDGET_VALUES[0] ||
        scale.megapixels !== I2VA_SCALE_WIDGET_VALUES[1] ||
        scale.resolution_steps !== I2VA_SCALE_WIDGET_VALUES[2]
      )
        return false;
    } else if (scales.length || sizes.length) {
      // CRITICAL: video_minimax_h3_i2v ships a dormant Scale -> Size pair for every
      // image-to-video mode. Non-I2VA children require inertness, not absence.
      // Do not restore the absence guard or delete the pair in materialization:
      // deleting template nodes changes parent-canvas/single-clip parity.
      if (scales.length !== 1 || sizes.length !== 1) return false;
      const scale = record(scales[0]!.node.inputs),
        size = record(sizes[0]!.node.inputs);
      if (
        scale === undefined ||
        scale.image !== undefined ||
        size === undefined ||
        !exactKeys(size, ["image"]) ||
        !linked(size.image, scales[0]!.id)
      )
        return false;
      if (
        nodes.some(({ id, node }) =>
          Object.entries(record(node.inputs) ?? {}).some(
            ([name, value]) =>
              isLink(value) &&
              (String(value[0]) === sizes[0]!.id ||
                (String(value[0]) === scales[0]!.id &&
                  (id !== sizes[0]!.id || name !== "image" || value[1] !== 0))),
          ),
        )
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
