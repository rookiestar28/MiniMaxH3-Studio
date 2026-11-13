import { describe, expect, it } from "vitest";
import {
  createManagedSequenceClient,
  decodeManagedSequenceMutationResult,
} from "../src/host/managedSequenceClient";
import { validatePreparedMediaFailurePayload } from "../src/host/managedSequenceClient";
function wire() {
  const fp = "sha256:" + "a".repeat(64);
  return {
    schema: "h3.context.managed_sequence_result.v2",
    parent_sequence_id: "parent.test",
    authorization_fingerprint: fp,
    read_authority_fingerprint: fp,
    state: "paused_failure",
    revision: 3,
    execution: null,
    execution_fingerprint: null,
    child_authority: null,
    context_workspace_handle: null,
    parent_expires_at_epoch_ms: 1000000,
    replayed: false,
    sequence_task_mode: "fl2va",
    failure_code: "sequence_media_changed",
  };
}
describe("frame parent result V2", () => {
  it.each(["sequence_media_changed", "sequence_media_unavailable"])(
    "refuses pre-bind reason %s for T2VA and extra fields",
    (failure_code) => {
      const payload = {
        parent_sequence_id: "parent.test",
        expected_revision: 2,
        authorization_fingerprint: "sha256:" + "a".repeat(64),
        segment_id: "segment.1",
        eligible_execution_fingerprint: "sha256:" + "b".repeat(64),
        failure_fingerprint: "sha256:" + "c".repeat(64),
        failure_code,
      };
      expect(() =>
        validatePreparedMediaFailurePayload(payload, "t2va"),
      ).toThrow();
      expect(() =>
        validatePreparedMediaFailurePayload(
          { ...payload, unexpected: true },
          "i2va",
        ),
      ).toThrow();
      expect(() =>
        validatePreparedMediaFailurePayload(payload, "i2va"),
      ).not.toThrow();
    },
  );
  it.each([null, "foreign_code", { code: "sequence_media_changed" }])(
    "refuses invalid optional pre-bind reason %j before transport",
    async (failure_code) => {
      let transports = 0;
      const client = createManagedSequenceClient({
        fetchApi: async () => {
          transports++;
          return new Response(JSON.stringify(wire()));
        },
      });
      await expect(
        client.send("failure.test", "fail_prepared_child", {
          parent_sequence_id: "parent.test",
          expected_revision: 2,
          authorization_fingerprint: "sha256:" + "a".repeat(64),
          segment_id: "segment.1",
          eligible_execution_fingerprint: "sha256:" + "b".repeat(64),
          failure_fingerprint: "sha256:" + "c".repeat(64),
          failure_code,
        }),
      ).rejects.toThrow();
      expect(transports).toBe(0);
    },
  );
  it.each(["sequence_media_changed", "sequence_media_unavailable"])(
    "keeps Start refusal %s without reflecting arbitrary error fields",
    async (error) => {
      const client = createManagedSequenceClient({
        fetchApi: async () =>
          new Response(JSON.stringify({ error }), { status: 409 }),
      });
      await expect(
        client.send("start.test", "start_sequence", { media_bindings: {} }),
      ).rejects.toMatchObject({ code: error, status: 409 });
    },
  );
  it.each(["extra", "unknown", "other-action", "no-bindings"])(
    "keeps generic refusal for %s",
    async (change) => {
      const value =
        change === "extra"
          ? { error: "sequence_media_changed", private: "synthetic" }
          : {
              error:
                change === "unknown" ? "synthetic" : "sequence_media_changed",
            };
      const client = createManagedSequenceClient({
        fetchApi: async () =>
          new Response(JSON.stringify(value), { status: 409 }),
      });
      await expect(
        client.send(
          "start.test",
          change === "other-action" ? "retry_segment" : "start_sequence",
          change === "no-bindings" ? {} : { media_bindings: {} },
        ),
      ).rejects.toMatchObject({ code: "managed_sequence_rejected" });
    },
  );
  it.each(["sequence_media_changed", "sequence_media_unavailable", null])(
    "keeps the closed code %s",
    (failure_code) => {
      const result = decodeManagedSequenceMutationResult(
        { ...wire(), failure_code },
        "fl2va",
      );
      expect(result.schema).toBe("h3.context.managed_sequence_result.v2");
      expect(result).toMatchObject({
        sequenceTaskMode: "fl2va",
        failureCode: failure_code,
      });
    },
  );
  it.each(["mode", "t2va", "legacy", "code", "state", "extra"])(
    "refuses invalid %s pairing",
    (change) => {
      const value: Record<string, unknown> = wire();
      if (change === "mode") value.sequence_task_mode = "i2va";
      if (change === "t2va") value.sequence_task_mode = "t2va";
      if (change === "legacy") {
        value.schema = "h3.context.managed_sequence_result.v1";
        delete value.sequence_task_mode;
        delete value.failure_code;
      }
      if (change === "code") value.failure_code = "private-marker";
      if (change === "state") value.state = "active";
      if (change === "extra") value.locator = "private-marker";
      expect(() =>
        decodeManagedSequenceMutationResult(value, "fl2va"),
      ).toThrow();
    },
  );
  it("refuses frame V2 for an expected T2VA parent", () => {
    expect(() => decodeManagedSequenceMutationResult(wire(), "t2va")).toThrow();
  });
});
