import rawTransition from "../../../governance/contracts/host_seam_census_transition_v1.json" with { type: "json" };
import rawM23_18Transition from "../../../governance/contracts/host_seam_census_transition_m23_18_v1.json" with { type: "json" };
import rawM23_19Transition from "../../../governance/contracts/host_seam_census_transition_m23_19_v1.json" with { type: "json" };
import rawM23_25Transition from "../../../governance/contracts/host_seam_census_transition_m23_25_v1.json" with { type: "json" };
import rawM25_02Transition from "../../../governance/contracts/host_seam_census_transition_m25_02_v1.json" with { type: "json" };
import rawM23_24Transition from "../../../governance/contracts/host_seam_census_transition_m23_24_v1.json" with { type: "json" };
import rawM23_47Transition from "../../../governance/contracts/host_seam_census_transition_m23_47_v1.json" with { type: "json" };
import rawM23_28Transition from "../../../governance/contracts/host_seam_census_transition_m23_28_v1.json" with { type: "json" };
import rawM26_04Transition from "../../../governance/contracts/host_seam_census_transition_m26_04_v1.json" with { type: "json" };
import rawM26_03Transition from "../../../governance/contracts/host_seam_census_transition_m26_03_v1.json" with { type: "json" };
import rawM25_13Transition from "../../../governance/contracts/host_seam_census_transition_m25_13_v1.json" with { type: "json" };
import rawManagedQualificationTransition from "../../../governance/contracts/host_seam_census_transition_managed_qualification_v1.json" with { type: "json" };
import rawM25_16Transition from "../../../governance/contracts/host_seam_census_transition_m25_16_v1.json" with { type: "json" };
import rawM16_05Transition from "../../../governance/contracts/host_seam_census_transition_m16_05_v1.json" with { type: "json" };
import rawM25_33Transition from "../../../governance/contracts/host_seam_census_transition_m25_33_v1.json" with { type: "json" };
import rawM16_05ReleaseTransition from "../../../governance/contracts/host_seam_census_transition_m16_05_release_v1.json" with { type: "json" };
import rawM25_38Transition from "../../../governance/contracts/host_seam_census_transition_m25_38_v1.json" with { type: "json" };
import rawModalKeyboardTransition from "../../../governance/contracts/host_seam_census_transition_modal_keyboard_v1.json" with { type: "json" };
import rawWorkspaceStateTransition from "../../../governance/contracts/host_seam_census_transition_workspace_state_v1.json" with { type: "json" };
import rawRetainedMediaTransition from "../../../governance/contracts/host_seam_census_transition_retained_media_v1.json" with { type: "json" };
import rawProjectPersistenceTransition from "../../../governance/contracts/host_seam_census_transition_project_persistence_v1.json" with { type: "json" };
import rawPerceptionHostTransition from "../../../governance/contracts/host_seam_census_transition_perception_host_v1.json" with { type: "json" };
import rawReferenceCropTransition from "../../../governance/contracts/host_seam_census_transition_reference_crop_v1.json" with { type: "json" };
import rawFrameSourcesTransition from "../../../governance/contracts/host_seam_census_transition_frame_sources_v1.json" with { type: "json" };
import rawBaseline from "../../../governance/contracts/host_seam_drift_baseline_v1.json" with { type: "json" };
import { verifyHostSeamBaseline } from "./hostSeamDrift";

// IMPORTANT: supported-host and offline preflight share the complete ordered chain.
// A duplicated browser list previously omitted an accepted transition and refused valid census bytes.
export const currentHostSeamTransitions = [
  rawTransition,
  rawM23_18Transition,
  rawM23_19Transition,
  rawM23_25Transition,
  rawM25_02Transition,
  rawM23_24Transition,
  rawM23_47Transition,
  rawM23_28Transition,
  rawM26_04Transition,
  rawM26_03Transition,
  rawM25_13Transition,
  rawManagedQualificationTransition,
  rawM25_16Transition,
  rawM16_05Transition,
  rawM25_33Transition,
  rawM16_05ReleaseTransition,
  rawM25_38Transition,
  rawModalKeyboardTransition,
  rawWorkspaceStateTransition,
  rawRetainedMediaTransition,
  rawProjectPersistenceTransition,
  rawPerceptionHostTransition,
  rawReferenceCropTransition,
  rawFrameSourcesTransition,
] as const;

export function verifyCurrentHostSeamBaseline(
  censusBytes: Uint8Array,
  fixtureBytes: Uint8Array,
) {
  return verifyHostSeamBaseline(
    rawBaseline,
    censusBytes,
    fixtureBytes,
    currentHostSeamTransitions,
  );
}
