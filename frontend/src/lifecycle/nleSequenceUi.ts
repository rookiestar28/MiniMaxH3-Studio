import type { NleSequenceUiState } from "../state/nleWorkspaceState";

type SequenceUiInputs = Readonly<{
  attached: boolean;
  parentState: string | null;
  activeSegmentId: string | null;
  activeQueuePromptId: string | null;
  failure: string | null;
}>;

export function deriveSequenceUi(
  previous: NleSequenceUiState,
  snapshot: SequenceUiInputs,
): NleSequenceUiState {
  if (snapshot.parentState === null)
    return previous === "starting" && snapshot.failure === null
      ? "starting"
      : "idle";
  if (snapshot.parentState === "authorized") return "idle";
  if (
    snapshot.parentState === "succeeded" ||
    snapshot.parentState === "cancelled"
  )
    return "finished";
  if (snapshot.parentState === "paused_failure") return "failed";
  if (snapshot.parentState === "paused_unknown_ownership")
    return "paused_unknown_ownership";
  if (snapshot.parentState === "paused_client_absent")
    return previous === "resume_ready" ||
      previous === "current_segment_completed" ||
      previous === "current_segment_still_owned"
      ? previous
      : "safe_to_leave";
  if (snapshot.parentState === "active" && snapshot.failure !== null)
    return "failed";
  if (snapshot.attached) {
    if (previous === "detaching") return "detaching";
    return snapshot.activeQueuePromptId !== null
      ? "detach_ready"
      : "attached_current_child";
  }
  return previous === "reattach_reconciling" ||
    previous === "current_segment_completed" ||
    previous === "current_segment_still_owned" ||
    previous === "resume_ready" ||
    previous === "recovery_unavailable_or_expired"
    ? previous
    : "safe_to_leave";
}
