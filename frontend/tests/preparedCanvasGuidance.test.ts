import { describe, expect, it, vi } from "vitest";

import type { AppModeInputs } from "../src/host/appMode";
import type { GraphInspection } from "../src/host/graphAdapter";
import { diagnosticShellStateSignature } from "../src/state/managedJournal";
import { preparedCanvasState } from "../src/state/preparedCanvasGuidance";
import { reduceShellState, type ShellAction } from "../src/state/shellState";

const inputs: AppModeInputs = {
  task_mode: "i2va",
  user_intent: "Prepare before choosing an image.",
  duration_milliseconds: 5000,
  frame_count: 120,
};
const ready: GraphInspection = {
  status: "ready",
  anchors: [
    { executionId: "8", nodeId: "comfyui_h3_context.H3Context.ProductShell" },
  ],
  existingGraphCompatible: true,
  nodeCount: 18,
};
const prepared = () =>
  preparedCanvasState(inputs, () => ({ graphFingerprint: "committed-write" }));
const refresh = (
  graphFingerprint?: string,
  inspection = ready,
): ShellAction => ({
  type: "graph",
  graphFingerprint,
  inspection,
});

describe("write-bound prepared source guidance", () => {
  it("keeps the reminder through repeated same-write rescans without changing classification", () => {
    let state = prepared();
    for (let index = 0; index < 3; index += 1) {
      state = reduceShellState(state, refresh("committed-write"));
      expect(state).toMatchObject({
        status: "interactive",
        reason: "native_preference",
        preparedGraphFingerprint: "committed-write",
        unchosenSourceRoles: ["firstFrame"],
      });
      expect(diagnosticShellStateSignature(state)).toBe(
        "interactive:native_preference",
      );
    }
  });

  it.each(["loader-edited", "foreign-canvas", undefined])(
    "clears guidance after changed or missing identity (%s)",
    (identity) => {
      const changed = reduceShellState(prepared(), refresh(identity));
      expect(changed).not.toHaveProperty("preparedGraphFingerprint");
      expect(changed).not.toHaveProperty("unchosenSourceRoles");
      expect(
        reduceShellState(changed, refresh("committed-write")),
      ).not.toHaveProperty("unchosenSourceRoles");
    },
  );

  it.each([
    { ...ready, status: "missing" as const },
    { ...ready, status: "ambiguous" as const },
    { ...ready, status: "incompatible" as const },
    { ...ready, existingGraphCompatible: false },
  ])("clears guidance after a non-admitted rescan (%j)", (inspection) => {
    const state = reduceShellState(
      prepared(),
      refresh("committed-write", inspection),
    );
    expect(state).not.toHaveProperty("preparedGraphFingerprint");
    expect(state).not.toHaveProperty("unchosenSourceRoles");
  });

  it.each<ShellAction>([
    { type: "working", phase: "materializing", transactionId: 2 },
    { type: "working", phase: "compiling", transactionId: 2 },
    { type: "interactive", reason: "native_preference" },
    { type: "interactive", reason: "cancelled" },
    { type: "reset" },
  ])(
    "clears guidance on a new run, queue or explicit decision (%j)",
    (action) => {
      const state = reduceShellState(prepared(), action);
      expect(state).not.toHaveProperty("preparedGraphFingerprint");
      expect(state).not.toHaveProperty("unchosenSourceRoles");
    },
  );

  it("suspends and restores guidance through a host disconnect", () => {
    const initial = prepared();
    const interrupted = reduceShellState(initial, {
      type: "host_unavailable",
      phase: "lost",
    });
    expect(interrupted).toMatchObject({
      status: "host_unavailable",
      prior: initial,
    });
    expect(reduceShellState(interrupted, { type: "host_restored" })).toBe(
      initial,
    );
  });

  it.each<AppModeInputs>([
    { ...inputs, first_frame_source: "9" },
    { ...inputs, task_mode: "t2va" },
    { ...inputs, task_mode: "l2va", last_frame_source: "9" },
    {
      ...inputs,
      task_mode: "fl2va",
      first_frame_source: "9",
      last_frame_source: "10",
    },
    { ...inputs, task_mode: "ref2va", reference_image_sources: ["9"] },
  ])("does not bind a fully sourced or T2VA preparation (%j)", (request) => {
    const read = vi.fn(() => ({ graphFingerprint: "committed-write" }));
    const state = preparedCanvasState(request, read);
    expect(read).not.toHaveBeenCalled();
    expect(state).not.toHaveProperty("preparedGraphFingerprint");
    expect(state).not.toHaveProperty("unchosenSourceRoles");
  });

  it.each([undefined, { graphFingerprint: "" }])(
    "fails closed when committed identity is unavailable (%j)",
    (identity) => {
      const state = preparedCanvasState(inputs, () => identity);
      expect(state).not.toHaveProperty("preparedGraphFingerprint");
      expect(state).not.toHaveProperty("unchosenSourceRoles");
    },
  );

  it("leaves an unbound compatible foreign graph on the normal native route", () => {
    const state = reduceShellState(
      { status: "interactive", reason: "pending_capability" },
      refresh("foreign-canvas"),
    );
    expect(state).toMatchObject({ reason: "native_preference" });
    expect(state).not.toHaveProperty("unchosenSourceRoles");
  });

  it("publishes the committed identity before a queued host event can run", async () => {
    let eventObservedPreparedState = false;
    const graphEvents = new EventTarget();
    graphEvents.addEventListener("graphChanged", () => {
      eventObservedPreparedState = state.status === "interactive";
      const changed = reduceShellState(state, refresh("queued-foreign-event"));
      expect(changed).not.toHaveProperty("unchosenSourceRoles");
    });
    const state = preparedCanvasState(inputs, () => {
      queueMicrotask(() =>
        graphEvents.dispatchEvent(new Event("graphChanged")),
      );
      return { graphFingerprint: "committed-write" };
    });
    expect(eventObservedPreparedState).toBe(false);
    expect(state).toHaveProperty("preparedGraphFingerprint", "committed-write");
    await Promise.resolve();
    expect(eventObservedPreparedState).toBe(true);
  });
});
