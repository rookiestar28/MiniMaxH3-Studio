import { sha256Text } from "../contracts/canonicalFingerprint";
import { withSequenceFailureAttribution } from "./managedSequenceDiagnostics";
import { MAX_CROP_DIMENSION } from "./imageCropGeometry";
import { IMAGE_CROP_NODE_TYPE } from "./imageCropCapability";
import {
  INPUT_GEOMETRY_RECEIPT_SCHEMA,
  isSafeInputLocator,
  type InputGeometryReceipt,
} from "./inputGeometry";

export const SEQUENCE_MEDIA_BINDING_SET_SCHEMA =
  "h3.context.sequence_media_binding_set.v1" as const;
export const MAX_SEQUENCE_MEDIA_BINDINGS = 3;
export const MAX_SEQUENCE_MEDIA_BINDING_BYTES = 4_096;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const fingerprint = /^sha256:[0-9a-f]{64}$/;
const roles = new Set([
  "primary",
  "first_frame",
  "last_frame",
  "reference",
  "subject_reference",
  "style_reference",
  "motion_reference",
  "camera_reference",
  "editing_source",
  "continuation_source",
  "audio_source",
]);

export type SequenceMediaCrop = Readonly<{
  node_id: string;
  class_type: typeof IMAGE_CROP_NODE_TYPE;
  region: Readonly<{ x: number; y: number; width: number; height: number }>;
}>;
export type SequenceMediaBinding = Readonly<{
  asset_id: string;
  role: string;
  kind: "image";
  loader_class: "LoadImage";
  loader_node_id: string;
  locator: string;
  source_identity: InputGeometryReceipt;
  registry_endpoint: Readonly<{
    node_id: string;
    input_name: string;
    source_node_id: string;
    source_slot: 0;
  }>;
  transform: SequenceMediaCrop | null;
}>;
export type SequenceMediaBindingSet = Readonly<{
  schema: typeof SEQUENCE_MEDIA_BINDING_SET_SCHEMA;
  entries: readonly SequenceMediaBinding[];
}>;

export class SequenceMediaBindingError extends Error {
  readonly category:
    | "sequence_media_binding_invalid"
    | "sequence_media_binding_size"
    | "sequence_media_changed"
    | "sequence_media_unavailable";
  constructor(
    category: SequenceMediaBindingError["category"],
    attribution?: unknown,
  ) {
    super(category);
    this.name = "SequenceMediaBindingError";
    this.category = category;
    withSequenceFailureAttribution(this, attribution);
  }
}
const invalid = (): never => {
  throw new SequenceMediaBindingError("sequence_media_binding_invalid");
};
function closed(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !("value" in (descriptors[key] ?? {})) ||
        descriptors[key]?.enumerable !== true,
    )
  )
    return invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  return typeof value === "string" && identifier.test(value)
    ? value
    : invalid();
}
function decodeCrop(value: unknown): SequenceMediaCrop | null {
  if (value === null) return null;
  const crop = closed(value, ["node_id", "class_type", "region"]);
  const region = closed(crop.region, ["x", "y", "width", "height"]);
  if (
    crop.class_type !== IMAGE_CROP_NODE_TYPE ||
    !["x", "y", "width", "height"].every(
      (key) =>
        Number.isSafeInteger(region[key]) &&
        Number(region[key]) >= (key === "width" || key === "height" ? 32 : 0) &&
        Number(region[key]) <= MAX_CROP_DIMENSION,
    ) ||
    Number(region.x) + Number(region.width) > MAX_CROP_DIMENSION ||
    Number(region.y) + Number(region.height) > MAX_CROP_DIMENSION
  )
    return invalid();
  return Object.freeze({
    node_id: id(crop.node_id),
    class_type: IMAGE_CROP_NODE_TYPE,
    region: Object.freeze({
      x: Number(region.x),
      y: Number(region.y),
      width: Number(region.width),
      height: Number(region.height),
    }),
  });
}
function decodeEntry(value: unknown): SequenceMediaBinding {
  const row = closed(value, [
    "asset_id",
    "role",
    "kind",
    "loader_class",
    "loader_node_id",
    "locator",
    "source_identity",
    "registry_endpoint",
    "transform",
  ]);
  const receipt = closed(row.source_identity, [
    "schema",
    "receipt_handle",
    "source_fingerprint",
  ]);
  const endpoint = closed(row.registry_endpoint, [
    "node_id",
    "input_name",
    "source_node_id",
    "source_slot",
  ]);
  const transform = decodeCrop(row.transform);
  // IMPORTANT: entries reserve compact UTF-8 bytes. UTF-16 code-unit counting would admit
  // oversized Unicode entries and break the backend's independent bounded retention owner.
  if (
    new TextEncoder().encode(JSON.stringify(row)).byteLength >
    MAX_SEQUENCE_MEDIA_BINDING_BYTES
  )
    throw new SequenceMediaBindingError("sequence_media_binding_size");
  if (
    row.kind !== "image" ||
    row.loader_class !== "LoadImage" ||
    typeof row.role !== "string" ||
    !roles.has(row.role) ||
    !isSafeInputLocator(row.locator) ||
    receipt.schema !== INPUT_GEOMETRY_RECEIPT_SCHEMA ||
    typeof receipt.receipt_handle !== "string" ||
    !/^ig_[A-Za-z0-9_-]{32,96}$/.test(receipt.receipt_handle) ||
    typeof receipt.source_fingerprint !== "string" ||
    !fingerprint.test(receipt.source_fingerprint) ||
    endpoint.source_slot !== 0 ||
    endpoint.source_node_id !== (transform?.node_id ?? row.loader_node_id) ||
    transform?.node_id === row.loader_node_id
  )
    return invalid();
  return Object.freeze({
    asset_id: id(row.asset_id),
    role: row.role,
    kind: "image",
    loader_class: "LoadImage",
    loader_node_id: id(row.loader_node_id),
    locator: row.locator,
    source_identity: Object.freeze({
      schema: INPUT_GEOMETRY_RECEIPT_SCHEMA,
      receipt_handle: receipt.receipt_handle,
      source_fingerprint: receipt.source_fingerprint,
    }),
    registry_endpoint: Object.freeze({
      node_id: id(endpoint.node_id),
      input_name: id(endpoint.input_name),
      source_node_id: id(endpoint.source_node_id),
      source_slot: 0,
    }),
    transform,
  });
}
export function decodeSequenceMediaBindingSet(
  value: unknown,
): SequenceMediaBindingSet {
  const wire = closed(value, ["schema", "entries"]);
  if (
    wire.schema !== SEQUENCE_MEDIA_BINDING_SET_SCHEMA ||
    !Array.isArray(wire.entries) ||
    wire.entries.length < 1 ||
    wire.entries.length > MAX_SEQUENCE_MEDIA_BINDINGS
  )
    return invalid();
  const entries = wire.entries.map(decodeEntry);
  if (new Set(entries.map((row) => row.asset_id)).size !== entries.length)
    return invalid();
  return Object.freeze({
    schema: SEQUENCE_MEDIA_BINDING_SET_SCHEMA,
    entries: Object.freeze(entries),
  });
}

function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function sequenceMediaBindingFingerprint(
  value: SequenceMediaBindingSet,
): string {
  const bindings = decodeSequenceMediaBindingSet(value);
  // CRITICAL: receipt allocation changes per observation; compare the file, loader/Registry
  // endpoint and exact crop instead, or every renewed receipt would look like changed media.
  const entries = [...bindings.entries]
    .sort((a, b) =>
      a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0,
    )
    .map(({ locator, ...row }) => ({
      ...row,
      locator_fingerprint: sha256Text(JSON.stringify(locator)),
      source_identity: {
        source_fingerprint: row.source_identity.source_fingerprint,
      },
    }));
  return sha256Text(
    JSON.stringify(canonical({ schema: bindings.schema, entries })),
  );
}
