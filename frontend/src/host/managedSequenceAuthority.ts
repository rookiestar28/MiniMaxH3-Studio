// Pure serial authority encoding and validation; the runner owns all effects.
import { sha256Text } from "../contracts/canonicalFingerprint";
import {
  decodeSequenceMediaBindingSet,
  SequenceMediaBindingError,
} from "./sequenceMediaBindings";
import { AppModeError } from "./appModeContract";
import type {
  SequenceMediaFailureCode,
  ManagedSequenceMutationResult,
} from "./managedSequenceClient";
import {
  ManagedSerialSequenceRunnerError,
  type ManagedSerialSequenceStartIntent,
  type ManagedSerialReuseAuthority,
  type ParentAuthority,
} from "./managedSequenceRunnerContract";

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const fingerprint = /^sha256:[0-9a-f]{64}$/;

export function runnerRequestId(
  phase: string,
  ...authority: unknown[]
): string {
  return `m26.${phase}.${sha256Text(
    JSON.stringify({
      schema: "h3.context.managed_serial_runner_request.v1",
      authority,
    }),
  ).slice(7, 47)}`;
}

export function safeFailureFingerprint(
  phase: string,
  disposition: string,
): string {
  return sha256Text(
    JSON.stringify({
      schema: "h3.context.managed_serial_runner_failure.v1",
      phase,
      disposition,
    }),
  );
}

export function mediaFailureCode(
  error: unknown,
): SequenceMediaFailureCode | undefined {
  const code =
    error instanceof SequenceMediaBindingError
      ? error.category
      : error instanceof AppModeError
        ? error.code
        : undefined;
  return code === "sequence_media_changed" ||
    code === "sequence_media_unavailable"
    ? code
    : undefined;
}

export function validateStartIntent(
  intent: ManagedSerialSequenceStartIntent,
): void {
  const segments = intent.segmentIds;
  if (
    segments.length < 1 ||
    segments.length > 15 ||
    new Set(segments).size !== segments.length ||
    segments.some((segmentId) => !identifier.test(segmentId)) ||
    !fingerprint.test(intent.qualificationFingerprint)
  )
    throw new ManagedSerialSequenceRunnerError("invalid_start_intent");
  const mode = intent.sequenceTaskMode ?? "t2va";
  if (
    !["t2va", "i2va", "l2va", "fl2va"].includes(mode) ||
    (mode === "t2va" && intent.mediaBindings !== undefined)
  )
    throw new ManagedSerialSequenceRunnerError("invalid_start_intent");
  if (intent.mediaBindings !== undefined)
    decodeSequenceMediaBindingSet(intent.mediaBindings);
  const authorization = intent.authorization;
  if (
    !/^pw_[A-Za-z0-9_-]{32,96}$/.test(authorization.workspace_handle) ||
    !Number.isSafeInteger(authorization.expected_workspace_revision) ||
    authorization.expected_workspace_revision < 1 ||
    authorization.expected_workspace_revision > 1_000_000 ||
    !fingerprint.test(authorization.expected_workspace_fingerprint) ||
    !fingerprint.test(authorization.expected_plan_fingerprint) ||
    !fingerprint.test(authorization.generation_plan_fingerprint) ||
    !fingerprint.test(authorization.compiler_fingerprint) ||
    !fingerprint.test(authorization.host_capability_fingerprint) ||
    authorization.explicit_intent !== "generate_approved_sequence"
  )
    throw new ManagedSerialSequenceRunnerError("invalid_start_intent");
}

export function parentAuthority(
  result: ManagedSequenceMutationResult,
): ParentAuthority {
  return Object.freeze({
    parentSequenceId: result.parentSequenceId,
    authorizationFingerprint: result.authorizationFingerprint,
    readAuthorityFingerprint: result.readAuthorityFingerprint,
    state: result.state,
    revision: result.revision,
    parentExpiresAtEpochMs: result.parentExpiresAtEpochMs,
  });
}

export function parentMutationPayload(
  authority: ParentAuthority,
  values: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    parent_sequence_id: authority.parentSequenceId,
    expected_revision: authority.revision,
    authorization_fingerprint: authority.authorizationFingerprint,
    ...values,
  };
}

export function parentProjectionAuthority(
  projection: Pick<
    ParentAuthority,
    "parentSequenceId" | "authorizationFingerprint" | "state" | "revision"
  >,
  pointer: Readonly<{
    readAuthorityFingerprint: string;
    expiresAtEpochMs: number;
  }>,
): ParentAuthority {
  return Object.freeze({
    parentSequenceId: projection.parentSequenceId,
    authorizationFingerprint: projection.authorizationFingerprint,
    readAuthorityFingerprint: pointer.readAuthorityFingerprint,
    state: projection.state,
    revision: projection.revision,
    parentExpiresAtEpochMs: pointer.expiresAtEpochMs,
  });
}

export function serialProjectionProgress(
  projection: Readonly<{
    slots: readonly Readonly<{
      segmentId: string;
      state: string;
      terminalFingerprint: string | null;
    }>[];
  }>,
) {
  const segmentIds = Object.freeze(
    projection.slots.map((slot) => slot.segmentId),
  );
  let nextIndex = projection.slots.findIndex(
    (slot) => slot.state !== "succeeded" && slot.state !== "reused",
  );
  if (nextIndex < 0) nextIndex = projection.slots.length;
  const lastSuccessfulTerminalFingerprint =
    nextIndex === 0
      ? null
      : (projection.slots[nextIndex - 1]?.terminalFingerprint ?? null);
  return Object.freeze({
    segmentIds,
    nextIndex,
    lastSuccessfulTerminalFingerprint,
  });
}

export function validateReuseAuthority(
  reuse: ManagedSerialReuseAuthority,
): void {
  if (
    !fingerprint.test(reuse.artifactReceiptFingerprint) ||
    !Number.isSafeInteger(reuse.byteLength) ||
    reuse.byteLength < 1 ||
    reuse.byteLength > 134_217_728 ||
    !fingerprint.test(reuse.terminalFingerprint)
  )
    throw new ManagedSerialSequenceRunnerError("child_authority_mismatch");
}
