import type { AppModeInputs } from "../host/appMode";
import { unchosenPreparationRoles } from "../host/appModeCanvasPreparation";
import type { GraphInspection } from "../host/graphAdapter";
import type { ShellState } from "./shellState";

type PreparedGuidance = Pick<
  Extract<ShellState, { status: "interactive" }>,
  "preparedGraphFingerprint" | "unchosenSourceRoles"
>;

/** Sample the committed host identity and publish readiness without an event-loop yield. */
export function preparedCanvasState(
  inputs: AppModeInputs,
  readIdentity: () => { graphFingerprint: string } | undefined,
): ShellState {
  const roles = unchosenPreparationRoles(inputs);
  const graphFingerprint = roles.length
    ? readIdentity()?.graphFingerprint
    : undefined;
  return {
    status: "interactive",
    reason: "canvas_ready",
    existingGraph: true,
    ...(graphFingerprint
      ? {
          preparedGraphFingerprint: graphFingerprint,
          unchosenSourceRoles: roles,
        }
      : {}),
  };
}

export function retainPreparedCanvasGuidance(
  state: ShellState,
  inspection: GraphInspection,
  graphFingerprint: string | undefined,
): PreparedGuidance {
  // CRITICAL: same-write rescans must retain the source reminder. Keeping it for
  // every compatible graph would attach stale instructions to a foreign canvas.
  if (
    state.status !== "interactive" ||
    !state.unchosenSourceRoles?.length ||
    !state.preparedGraphFingerprint ||
    graphFingerprint !== state.preparedGraphFingerprint ||
    inspection.status !== "ready" ||
    inspection.existingGraphCompatible !== true
  )
    return {};
  return {
    preparedGraphFingerprint: state.preparedGraphFingerprint,
    unchosenSourceRoles: state.unchosenSourceRoles,
  };
}
