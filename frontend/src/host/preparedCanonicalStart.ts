/** Canonical authority validation; private sequence counting requires managed ownership. */
import {
  AppModeError,
  PRODUCTION_CANONICAL_LOWERING_SCHEMA,
  PRODUCTION_FRAME_CANONICAL_LOWERING_SCHEMA,
  type AppModeInputs,
  type AppModeStartOptions,
  type ProductionCanonicalLowering,
} from "./appModeContract";
import { resolvePreparedSequenceSpliceMedia } from "./preparedSequenceMedia";
import { isBoundedPrivateCanonicalPrompt } from "./privateCanonicalPrompt";

export function validateProductionCanonicalLowering(
  value: ProductionCanonicalLowering,
  inputs: AppModeInputs,
): void {
  validateCanonicalLowering(value, inputs);
}

function validateCanonicalLowering(
  value: ProductionCanonicalLowering,
  inputs: AppModeInputs,
  privateSequence = false,
): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new AppModeError(
      "invalid_request",
      "the prepared canonical prompt authority is invalid",
    );
  const keys = Object.keys(value).sort();
  const frame = value.schema === PRODUCTION_FRAME_CANONICAL_LOWERING_SCHEMA;
  const expected = [
    "baseReportFingerprint",
    "baseReportRevision",
    "canonicalPrompt",
    "overrideRevision",
    "reason",
    "schema",
    ...(frame ? ["taskMode", "bindingRoles"] : []),
  ].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    (!frame && value.schema !== PRODUCTION_CANONICAL_LOWERING_SCHEMA) ||
    value.canonicalPrompt !== inputs.user_intent ||
    value.canonicalPrompt.length === 0 ||
    (privateSequence
      ? !isBoundedPrivateCanonicalPrompt(value.canonicalPrompt)
      : value.canonicalPrompt.length > 4096) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.baseReportFingerprint) ||
    value.baseReportRevision !== 0 ||
    value.overrideRevision !== 1 ||
    value.reason !== "Materialize approved Production segment prompt" ||
    (frame
      ? value.taskMode !== inputs.task_mode ||
        !Array.isArray(value.bindingRoles) ||
        JSON.stringify(value.bindingRoles) !==
          JSON.stringify(
            value.taskMode === "fl2va"
              ? ["first_frame", "last_frame"]
              : value.taskMode === "i2va"
                ? ["first_frame"]
                : value.taskMode === "l2va"
                  ? ["last_frame"]
                  : null,
          )
      : inputs.task_mode !== "t2va")
  )
    throw new AppModeError(
      "invalid_request",
      "the prepared canonical prompt authority is invalid",
    );
}

export function validatePreparedCanonicalStart(
  inputs: AppModeInputs,
  options: AppModeStartOptions,
): void {
  const authority = options.preparedCanonicalPrompt;
  const sequence = options.preparedSequenceMedia;
  if (sequence !== undefined) {
    if (
      authority === undefined ||
      options.prepareManaged === undefined ||
      options.prepareOnly === true ||
      options.useExisting === true ||
      options.connectExisting !== undefined
    )
      throw new AppModeError(
        "invalid_request",
        "sequence media requires one managed materialization owner",
      );
    resolvePreparedSequenceSpliceMedia(inputs, sequence);
  }
  if (authority === undefined) return;
  // IMPORTANT: this authority is runner-reserved; accepting it on an adopted
  // canvas or without managed ownership would let ordinary starts bypass the prepared claim.
  if (
    options.prepareManaged === undefined ||
    options.useExisting === true ||
    options.connectExisting !== undefined
  )
    throw new AppModeError(
      "invalid_request",
      "prepared canonical prompts require one managed materialization owner",
    );
  // CRITICAL: private counting follows closed retained media and managed-owner validation.
  // A canonical schema or caller flag alone must never widen ordinary App Mode input.
  validateCanonicalLowering(authority, inputs, sequence !== undefined);
  if (
    authority.schema === PRODUCTION_FRAME_CANONICAL_LOWERING_SCHEMA &&
    sequence === undefined
  )
    throw new AppModeError(
      "invalid_request",
      "frame canonical starts require retained sequence media",
    );
}
