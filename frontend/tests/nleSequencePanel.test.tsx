import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { NleSequencePanel } from "../src/components/nle/NleSequencePanel";
import { initialNleSequenceState } from "../src/state/nleWorkspaceState";
import { bindingFixture, expandedState } from "./support/nleWorkspaceBinding";
import { emptySequenceDiagnostics } from "../src/host/managedSequenceDiagnostics";
import {
  parseSequenceDiagnosticAttributes,
  sequenceDiagnosticAttributes,
} from "./e2e/host/frameSequenceDiagnostics";

afterEach(cleanup);

it("projects the exact closed hidden diagnostic contract without adding visible copy", () => {
  const base = bindingFixture({
    state: expandedState({
      sequence: { ...initialNleSequenceState, ui: "detach_ready" },
    }),
  });
  const rendered = render(<NleSequencePanel binding={base} />);
  const text = rendered.container.textContent;
  const diagnostic = {
    ...emptySequenceDiagnostics(),
    failureAttribution: {
      origin: "compiled-locator" as const,
      boundary: "source-observe" as const,
      managedAction: "unattributed" as const,
      httpStatusClass: "unattributed" as const,
    },
    parentState: "active" as const,
    gate: {
      childOrdinal: 2 as const,
      artifactRecorded: true,
      terminalKindKnown: true,
      terminalFingerprintPresent: true,
      released: true,
      parentTerminalRecorded: true,
    },
    successor: { ordinal: 3 as const, prepared: false },
  };
  const next = bindingFixture({
    state: expandedState({
      sequence: {
        ...initialNleSequenceState,
        ui: "detach_ready",
        diagnostics: diagnostic,
      },
    }),
  });
  rendered.rerender(<NleSequencePanel binding={next} />);
  const panel = rendered.container.querySelector("[data-h3-nle-sequence-ui]")!;
  const values = Object.fromEntries(
    sequenceDiagnosticAttributes.map((key) => [
      key,
      panel.getAttribute(`data-h3-nle-${key}`),
    ]),
  );
  expect(parseSequenceDiagnosticAttributes(values)).toEqual({
    ...diagnostic,
    failureCode: null,
    uiState: "detach_ready",
  });
  expect(rendered.container.textContent).toBe(text);
  expect(next.actions.startSequence).not.toHaveBeenCalled();
});

it("announces the fixed recovery deadline after detach without extending it on remount", () => {
  const expiresAt = Date.UTC(2026, 8, 8, 12);
  const binding = bindingFixture({
    state: expandedState({
      sequence: {
        ...initialNleSequenceState,
        ui: "safe_to_leave",
        recoveryExpiresAtEpochMs: expiresAt,
      },
    }),
  });
  const first = render(<NleSequencePanel binding={binding} />);
  expect(screen.getByText(/2026-09-08T12:00:00.000Z/)).toBeTruthy();
  const original = first.container.querySelector(
    '[data-h3-nle-status="recovery-deadline"]',
  )!.textContent;
  first.unmount();
  const second = render(<NleSequencePanel binding={binding} />);
  expect(
    second.container.querySelector('[data-h3-nle-status="recovery-deadline"]')!
      .textContent,
  ).toBe(original);
  expect(binding.actions.startSequence).not.toHaveBeenCalled();
  expect(binding.actions.detachSequence).not.toHaveBeenCalled();
  expect(binding.actions.reattachSequence).not.toHaveBeenCalled();
});
