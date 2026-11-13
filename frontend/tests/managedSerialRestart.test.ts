import {
  plainReason,
  PLAIN_REASON_TABLES,
} from "../src/components/plainReasons";
import { sidebarCopy } from "../src/i18n/catalog";

// B-M1605-SEQ-02: a start refused before any parent sequence exists must not poison the page
// session. The runner marks itself started before its first request, so reusing that runner for
// the next explicit Generate answered `already_started` until the page was reloaded.

import { describe, expect, it, vi } from "vitest";

import {
  ManagedSequenceClientError,
  type ManagedSequenceMutationResult,
  type ManagedSerialSequenceStartIntent,
} from "../src/host/managedSequence";
import { createManagedSerialSession } from "../src/lifecycle/managedSerialSession";
import { AppModeError } from "../src/host/appMode";
import {
  createShellSession,
  type ShellRuntime,
} from "../src/lifecycle/shellSession";

const fp = (digit: string) => `sha256:${digit.repeat(64)}`;

const intent: ManagedSerialSequenceStartIntent = {
  authorization: {
    workspace_handle: `pw_${"w".repeat(40)}`,
    expected_workspace_revision: 1,
    expected_workspace_fingerprint: fp("1"),
    expected_plan_fingerprint: fp("2"),
    generation_plan_fingerprint: fp("3"),
    compiler_fingerprint: fp("4"),
    host_capability_fingerprint: fp("5"),
    explicit_intent: "generate_approved_sequence",
  },
  qualificationFingerprint: fp("6"),
  segmentIds: ["segment.1"],
};

function subject(
  send: (
    requestId: string,
    action: string,
  ) => Promise<ManagedSequenceMutationResult>,
) {
  const parentClient = { send: vi.fn(send), read: vi.fn() };
  const runtime = {
    session: createShellSession(),
    deps: {
      managedSequenceClient: parentClient,
      sequenceCoordinator: { send: vi.fn() },
      managedSequenceReattachStore: {
        read: vi.fn(() => undefined),
        replace: vi.fn(() => true),
        clear: vi.fn(),
      },
      comfyPromptHistoryClient: { read: vi.fn() },
    },
    actions: {},
  } as unknown as ShellRuntime;
  const serial = createManagedSerialSession(runtime, vi.fn());
  const bindings = { resolveChild: vi.fn() };
  const authorizations = () =>
    parentClient.send.mock.calls.filter(
      ([, action]) => action === "authorize_sequence",
    ).length;
  return { serial, bindings, authorizations };
}

describe("B-M1605-SEQ-02 managed serial restart", () => {
  it.each(["sequence_media_changed", "sequence_media_unavailable"] as const)(
    "keeps the bounded AppMode failure %s in the session",
    async (code) => {
      const ctx = subject(async () => {
        throw new AppModeError(code, "synthetic");
      });
      await expect(
        ctx.serial.startManagedSerialSequence(intent, ctx.bindings),
      ).rejects.toMatchObject({ code });
      expect(ctx.serial.managedSerialSequenceSnapshot()).toMatchObject({
        failure: code,
      });
    },
  );
  it("starts again with a fresh runner after a start refused before any parent existed", async () => {
    const ctx = subject(async () => {
      throw new ManagedSequenceClientError("managed_sequence_rejected", 409);
    });
    await expect(
      ctx.serial.startManagedSerialSequence(intent, ctx.bindings),
    ).rejects.toMatchObject({ code: "managed_sequence_rejected" });
    expect(ctx.serial.managedSerialSequenceSnapshot()).toMatchObject({
      parentState: null,
      failure: "managed_sequence_rejected",
    });
    await expect(
      ctx.serial.startManagedSerialSequence(intent, ctx.bindings),
    ).rejects.toMatchObject({ code: "managed_sequence_rejected" });
    expect(ctx.authorizations()).toBe(2);
  });

  it("keeps a start that is still in flight exclusive", async () => {
    let release: (() => void) | undefined;
    const ctx = subject(
      () =>
        new Promise((_resolve, reject) => {
          release = () =>
            reject(
              new ManagedSequenceClientError("managed_sequence_rejected", 409),
            );
        }),
    );
    const first = ctx.serial.startManagedSerialSequence(intent, ctx.bindings);
    const second = ctx.serial.startManagedSerialSequence(intent, ctx.bindings);
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await expect(first).rejects.toMatchObject({
      code: "managed_sequence_rejected",
    });
    await expect(second).rejects.toMatchObject({ code: "already_started" });
    expect(ctx.authorizations()).toBe(1);
  });
});

describe("managed serial compile reporting", () => {
  const compileFailure = () =>
    new AppModeError(
      "compile_failed",
      "synthetic private compile detail",
      { kind: "template_unavailable" },
      "compiled_admission",
      "requested_route",
    );

  it("keeps only the closed compile code in the session snapshot", async () => {
    const original = compileFailure();
    const ctx = subject(async () => {
      throw original;
    });
    await expect(
      ctx.serial.startManagedSerialSequence(intent, ctx.bindings),
    ).rejects.toBe(original);
    const snapshot = ctx.serial.managedSerialSequenceSnapshot();
    for (const property of [
      "message",
      "reason",
      "compileStep",
      "compileAdmission",
    ])
      expect(snapshot).not.toHaveProperty(property);
    expect(JSON.stringify(snapshot)).not.toContain(original.message);
    expect(JSON.stringify(snapshot)).not.toContain("requested_route");
    expect(snapshot).toMatchObject({ failure: "compile_failed" });
  });

  it.each(["en", "zh-TW", "zh-CN"] as const)(
    "renders the snapshot through actual plainReason and existing %s catalog copy",
    async (locale) => {
      const original = compileFailure();
      const ctx = subject(async () => {
        throw original;
      });
      await expect(
        ctx.serial.startManagedSerialSequence(intent, ctx.bindings),
      ).rejects.toBe(original);
      const existingCopy = sidebarCopy(locale).errorMessages.compile_failed;
      // Pin the actual formatter independently of the lifecycle mapping.
      expect(plainReason(locale, "sequence", "compile_failed")).toBe(
        existingCopy,
      );
      const snapshot = ctx.serial.managedSerialSequenceSnapshot();
      expect(snapshot.failure).toBe("compile_failed");
      const visible = plainReason(locale, "sequence", snapshot.failure);
      expect(visible).toBe(existingCopy);
      for (const forbidden of [
        original.message,
        "compile_failed",
        "compiled_admission",
        "requested_route",
        "template_unavailable",
      ])
        expect(visible).not.toContain(forbidden);
    },
  );

  it.each([
    [
      "unrelated AppMode queue error",
      new AppModeError("queue_failed", "synthetic queue detail"),
    ],
    [
      "unrelated AppMode seam error",
      new AppModeError("incompatible_seam", "synthetic seam detail"),
    ],
    ["unknown error", new Error("synthetic unknown detail")],
  ] as const)("keeps %s generic", async (_label, original) => {
    const ctx = subject(async () => {
      throw original;
    });
    await expect(
      ctx.serial.startManagedSerialSequence(intent, ctx.bindings),
    ).rejects.toBe(original);
    expect(ctx.serial.managedSerialSequenceSnapshot()).toMatchObject({
      failure: "managed_sequence_failed",
    });
    expect(
      JSON.stringify(ctx.serial.managedSerialSequenceSnapshot()),
    ).not.toContain(original.message);
  });

  it.each(["en", "zh-TW", "zh-CN"] as const)(
    "retains the %s unknown sequence-code fallback",
    (locale) => {
      expect(
        plainReason(locale, "sequence", "synthetic_unknown_sequence_code"),
      ).toBe(PLAIN_REASON_TABLES[locale].sequence.fallback);
    },
  );
});
