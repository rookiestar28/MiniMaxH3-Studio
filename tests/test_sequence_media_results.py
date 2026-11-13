"""Frame-parent typed failure result preserves the claim-time refusal and replay."""

import json
from dataclasses import replace
from typing import NoReturn, cast

import pytest
from test_frame_mode_sequence_start import frame_start_fixture
from test_m26_04_managed_sequence_service import _child_correlation, _child_observation

from comfyui_h3_context.adapters import managed_sequence_service as m
from comfyui_h3_context.core.contracts import TaskMode
from comfyui_h3_context.core.managed_sequence import EligibleSegmentExecutionV1


def prepared_frame() -> tuple[
    m.ManagedSequenceService, m.ManagedSequenceMutationResultV1, m.BindManagedSequenceChildRequestV1
]:
    service, request, qualification, bindings, *_ = frame_start_fixture()
    started = service.start(replace(request, media_bindings=bindings), qualification=qualification)
    segment = cast(m._ServiceEntry, service._entry).sequence.authorization.segments[0].segment_id
    prepared = service.prepare_child(
        m.PrepareManagedSequenceChildRequestV1(
            request_id="prepare.typed",
            parent_sequence_id=started.parent_sequence_id,
            expected_revision=started.revision,
            authorization_fingerprint=started.authorization_fingerprint,
            segment_id=segment,
            predecessor_terminal_fingerprint=None,
        )
    )
    wire = _child_observation(segment).to_wire()
    wire.pop("source_identity")
    wire.update(
        schema="h3.context.prepared_graph_observation.v5",
        expected_frames=192,
        media_binding_fingerprint=bindings.fingerprint,
        source_identities=[
            dict(
                asset_id=row.asset_id,
                role=row.role.value,
                receipt_handle=row.source_identity.receipt_handle,
                source_fingerprint=row.source_identity.source_fingerprint,
            )
            for row in bindings.entries
        ],
    )
    observation = m.ManagedPreparedGraphObservationV1.from_wire(wire)
    execution = cast(EligibleSegmentExecutionV1, prepared.execution)
    bind = m.BindManagedSequenceChildRequestV1(
        request_id="bind.typed",
        parent_sequence_id=started.parent_sequence_id,
        expected_revision=prepared.revision,
        authorization_fingerprint=started.authorization_fingerprint,
        segment_id=segment,
        eligible_execution_fingerprint=execution.fingerprint,
        materialization_receipt_fingerprint=execution.materialization_receipt_fingerprint,
        graph_fingerprint=observation.graph_fingerprint,
        compiled_prompt_fingerprint=observation.compiled_prompt_fingerprint,
        owned_projection_fingerprint=observation.owned_projection_fingerprint,
        previous_owned_projection_fingerprint=observation.owned_projection_fingerprint,
        active_workflow_fingerprint="sha256:" + "a" * 64,
        correlation=_child_correlation(),
        observation=observation,
    )
    return service, started, bind


@pytest.mark.parametrize("code", ["sequence_media_changed", "sequence_media_unavailable"])
def test_claim_time_media_failure_is_typed_committed_and_replayed(code: str) -> None:
    service, started, request = prepared_frame()
    calls: list[m.ManagedChildBindingRequestV1] = []

    def refused(claim: m.ManagedChildBindingRequestV1) -> NoReturn:
        calls.append(claim)
        raise m.ManagedSequenceServiceError(code, 409)

    service._bind_child = refused
    result = service.bind_child(request)
    assert result.state.value == "paused_failure"
    wire = result.to_wire()
    assert wire["schema"] == "h3.context.managed_sequence_result.v2"
    assert wire["sequence_task_mode"] == "fl2va" and wire["failure_code"] == code
    replay = service.bind_child(request)
    assert replay.to_wire() == {**wire, "replayed": True}
    assert len(calls) == 1 and not result.child_authority
    assert "locator" not in json.dumps(wire) and "ImageCropV2" not in json.dumps(wire)
    assert len(json.dumps(wire).encode()) <= 8192
    assert (
        m.decode_managed_sequence_result(wire, expected_sequence_mode=TaskMode.FL2VA).to_wire()
        == wire
    )
    with pytest.raises(ValueError):
        m.decode_managed_sequence_result(wire, expected_sequence_mode=TaskMode.T2VA)
    legacy = {
        key: value
        for key, value in wire.items()
        if key not in {"sequence_task_mode", "failure_code"}
    }
    legacy["schema"] = m.MANAGED_SEQUENCE_RESULT_SCHEMA
    with pytest.raises(ValueError):
        m.decode_managed_sequence_result(legacy, expected_sequence_mode=TaskMode.FL2VA)


@pytest.mark.parametrize(
    "state,code",
    [
        ("active", "sequence_media_changed"),
        ("cancelled", "sequence_media_unavailable"),
        ("paused_failure", "foreign_code"),
    ],
)
def test_frame_result_decoder_refuses_nonpaused_and_unknown_codes(state: str, code: str) -> None:
    service, started, _request = prepared_frame()
    wire = started.to_wire()
    wire.update(
        schema="h3.context.managed_sequence_result.v2",
        sequence_task_mode="fl2va",
        state=state,
        failure_code=code,
    )
    with pytest.raises(ValueError):
        m.decode_managed_sequence_result(wire, expected_sequence_mode=TaskMode.FL2VA)
