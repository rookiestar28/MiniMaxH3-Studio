import type { AppModeInputs } from "../../src/host/appModeContract";
import type { PreparedSequenceMedia } from "../../src/host/preparedSequenceMedia";
import { decodeSequenceMediaBindingSet } from "../../src/host/sequenceMediaBindings";

export function preparedSequenceMediaFixture(
  task: AppModeInputs["task_mode"],
  global: PreparedSequenceMedia["sequenceTaskMode"],
  cropped = false,
) {
  const roles =
    task === "fl2va"
      ? ["first_frame", "last_frame"]
      : task === "i2va" || global === "i2va"
        ? ["first_frame"]
        : task === "l2va"
          ? ["last_frame"]
          : [];
  const rows = roles.map((role, index) => ({
    asset_id: `${role}_1`,
    role,
    kind: "image",
    loader_class: "LoadImage",
    loader_node_id: String(80 + index),
    locator: `synthetic/${role}.png`,
    source_identity: {
      schema: "h3.context.input_geometry.receipt.v2",
      receipt_handle: "ig_" + "r".repeat(40),
      source_fingerprint: "sha256:" + String(index + 1).repeat(64),
    },
    registry_endpoint: {
      node_id: "75",
      input_name: role,
      source_node_id: String(cropped ? 90 + index : 80 + index),
      source_slot: 0,
    },
    transform: cropped
      ? {
          node_id: String(90 + index),
          class_type: "ImageCropV2",
          region: { x: 16, y: 32, width: 96, height: 64 },
        }
      : null,
  }));
  const inputs: AppModeInputs = {
    task_mode: task,
    user_intent: "synthetic shot",
    duration_milliseconds: 6000,
    frame_count: 158,
    ...(task === "i2va" || task === "fl2va"
      ? {
          first_frame_source: rows.find((row) => row.role === "first_frame")!
            .loader_node_id,
        }
      : {}),
    ...(task === "l2va" || task === "fl2va"
      ? {
          last_frame_source: rows.find((row) => row.role === "last_frame")!
            .loader_node_id,
        }
      : {}),
  };
  const prepared: PreparedSequenceMedia = {
    sequenceTaskMode: global,
    bindings: rows.length
      ? decodeSequenceMediaBindingSet({
          schema: "h3.context.sequence_media_binding_set.v1",
          entries: rows,
        })
      : null,
    geometryDonorAssetId: global === "i2va" ? "first_frame_1" : null,
  };
  return { inputs, prepared };
}
