"""Concrete Start gate before any run reservation, using real canonical frame materialization."""

import json
from dataclasses import replace
from typing import Any, NoReturn, cast

import pytest
from test_m26_03_context_materializer import _proposal, _source
from test_m26_04_managed_sequence_service import (
    _authorization,
    _authorize_request,
    _ProductionRegistry,
    _qualification,
)
from test_sequence_media_bindings import binding_wire

from comfyui_h3_context.adapters import managed_sequence_service as service_module
from comfyui_h3_context.adapters.comfyui_input_geometry import (
    GeometryPreflightError,
    InputGeometryReceipt,
)
from comfyui_h3_context.adapters.comfyui_sidebar_workspace import SidebarWorkspaceRegistry
from comfyui_h3_context.adapters.production_context_materializer import (
    CanonicalProductionMaterializer,
    claim_canonical_production_materialization,
)
from comfyui_h3_context.adapters.sequence_media_bindings import SequenceMediaBindingSetV1
from comfyui_h3_context.core.contracts import TaskMode
from comfyui_h3_context.core.managed_sequence import (
    EligibleSegmentExecutionV1,
    ManagedModeQualificationV1,
    ManagedSequenceAuthorizationV1,
)
from comfyui_h3_context.core.production_import import derive_segment_context_materialization_receipt


def frame_start_fixture() -> tuple[
    service_module.ManagedSequenceService,
    service_module.StartManagedSequenceRequestV1,
    ManagedModeQualificationV1,
    SequenceMediaBindingSetV1,
    list[service_module.ManagedSequenceStartResourceRequestV1],
    list[dict[str, object]],
]:
    sidebar = SidebarWorkspaceRegistry(max_entries=4, ttl_seconds=60)
    source = _source(sidebar, mode=TaskMode.FL2VA)
    context, proposal = _proposal(source, parts=(8,))
    materializer = CanonicalProductionMaterializer(source, workspace_registry=sidebar)
    raw = materializer(context, proposal, proposal.segments[0])
    receipt = derive_segment_context_materialization_receipt(
        context, proposal, proposal.segments[0], raw
    )
    raw.release()
    source_authority = object()
    resources: list[service_module.ManagedSequenceStartResourceRequestV1] = []
    claims: list[dict[str, object]] = []

    def builder(_source: object, **values: Any) -> ManagedSequenceAuthorizationV1:
        authority = _authorization(values["sequence_id"], count=1)
        row = replace(
            authority.segments[0],
            segment_id=receipt.segment_id,
            task_mode=receipt.task_mode,
            duration_milliseconds=receipt.duration_milliseconds,
            frame_count=receipt.frame_count,
            materialization_receipt_fingerprint=receipt.fingerprint,
            local_prompt_fingerprint=receipt.local_prompt_fingerprint,
            intent_graph_fingerprint=receipt.intent_graph_fingerprint,
            profile_fingerprint=receipt.profile_fingerprint,
            capability_fingerprint=receipt.capability_fingerprint,
        )
        return replace(
            authority, host_capability_fingerprint=receipt.capability_fingerprint, segments=(row,)
        )

    def materialize(
        _authority: object, segment_id: str
    ) -> service_module.ManagedSegmentMaterializationClaimV2:
        assert _authority is source_authority and segment_id == receipt.segment_id
        raw = materializer(context, proposal, proposal.segments[0])
        current = derive_segment_context_materialization_receipt(
            context, proposal, proposal.segments[0], raw
        )
        return service_module.ManagedSegmentMaterializationClaimV2(
            context_workspace_handle=raw.context_workspace_handle,
            segment_id=segment_id,
            materialization_receipt_fingerprint=current.fingerprint,
            receipt=current,
            materialization=claim_canonical_production_materialization(raw),
            release=raw.release,
        )

    def reserve(
        request: service_module.ManagedSequenceStartResourceRequestV1,
    ) -> service_module.ManagedSequenceStartResourceClaimV1:
        resources.append(request)
        return service_module.ManagedSequenceStartResourceClaimV1(
            request_fingerprint=request.fingerprint,
            coordinator_reservation_fingerprint="sha256:" + "1" * 64,
            child_slot_reservation_fingerprint="sha256:" + "2" * 64,
            artifact_reservation_fingerprint="sha256:" + "3" * 64,
            consume=lambda *_: None,
            release=lambda: None,
        )

    service = service_module.ManagedSequenceService(
        production_registry=_ProductionRegistry(source_authority),
        authorization_builder=builder,
        materialize_segment=materialize,
        reserve_start_resources=reserve,
        token_factory=lambda: "a" * 40,
        clock=lambda: 100.0,
        epoch_clock_ms=lambda: 1000000,
    )

    def claim_source(value: object, *, locator: str) -> InputGeometryReceipt:
        claims.append({"locator": locator})
        return InputGeometryReceipt.from_wire(value)

    service._media_source_claimant = claim_source
    authorized = service.authorize(
        replace(_authorize_request(), host_capability_fingerprint=receipt.capability_fingerprint)
    )
    authority = builder(source_authority, sequence_id=authorized.parent_sequence_id)
    request = service_module.StartManagedSequenceRequestV1(
        request_id="start.frame",
        parent_sequence_id=authorized.parent_sequence_id,
        expected_revision=authorized.revision,
        authorization_fingerprint=authorized.authorization_fingerprint,
    )
    entries = []
    for index, asset in enumerate(source.report.request.reference_registry.assets):
        row = binding_wire(index)
        row["asset_id"], row["role"] = asset.asset_id, asset.role.value
        row["registry_endpoint"]["input_name"] = asset.role.value
        entries.append(row)
    bindings = SequenceMediaBindingSetV1.from_wire(
        {"schema": "h3.context.sequence_media_binding_set.v1", "entries": entries}
    )
    return service, request, _qualification(authority), bindings, resources, claims


def test_start_requires_complete_bindings_before_reserving_and_remains_retryable() -> None:
    service, request, qualification, bindings, resources, claims = frame_start_fixture()
    before = cast(service_module._ServiceEntry, service._entry).sequence
    with pytest.raises(
        service_module.ManagedSequenceServiceError, match="sequence_media_binding_missing"
    ):
        service.start(request, qualification=qualification)
    assert (
        cast(service_module._ServiceEntry, service._entry).sequence is before
        and not resources
        and not claims
    )
    corrected = replace(request, media_bindings=bindings)
    result = service.start(corrected, qualification=qualification)
    assert result.state.value == "active" and len(resources) == 1 and len(claims) == 2
    assert service._sequence_media.get(result.parent_sequence_id) is bindings
    public = json.dumps(result.to_wire())
    assert "synthetic/source" not in public and "ImageCropV2" not in public
    assert service.start(corrected, qualification=qualification).replayed
    assert len(resources) == 1 and len(claims) == 2


def test_start_receipt_failure_does_not_commit_or_reserve() -> None:
    service, request, qualification, bindings, resources, _claims = frame_start_fixture()
    before = cast(service_module._ServiceEntry, service._entry).sequence

    def changed(*args: object, **kwargs: object) -> NoReturn:
        raise GeometryPreflightError("input_changed", 409)

    service._media_source_claimant = changed
    with pytest.raises(service_module.ManagedSequenceServiceError, match="sequence_media_changed"):
        service.start(replace(request, media_bindings=bindings), qualification=qualification)
    assert cast(service_module._ServiceEntry, service._entry).sequence is before and not resources
    assert service._sequence_media.parent_count == 0


def test_start_replay_identity_preserves_exact_locator_spelling() -> None:
    service, request, qualification, bindings, *_ = frame_start_fixture()
    wire = cast(dict[str, Any], bindings.to_wire())
    wire["entries"][0]["locator"] = "synthetic/\u00e9.png"
    first = replace(request, media_bindings=SequenceMediaBindingSetV1.from_wire(wire))
    service.start(first, qualification=qualification)
    wire["entries"][0]["locator"] = "synthetic/e\u0301.png"
    changed = replace(request, media_bindings=SequenceMediaBindingSetV1.from_wire(wire))
    with pytest.raises(service_module.ManagedSequenceServiceError, match="request_id_conflict"):
        service.start(changed, qualification=qualification)


def test_frame_prepared_context_v2_is_private_selected_and_t2va_v1_stays_separate() -> None:
    service, request, qualification, bindings, *_ = frame_start_fixture()
    started = service.start(replace(request, media_bindings=bindings), qualification=qualification)
    segment_id = (
        cast(service_module._ServiceEntry, service._entry)
        .sequence.authorization.segments[0]
        .segment_id
    )
    prepared = service.prepare_child(
        service_module.PrepareManagedSequenceChildRequestV1(
            request_id="prepare.frame",
            parent_sequence_id=started.parent_sequence_id,
            expected_revision=started.revision,
            authorization_fingerprint=started.authorization_fingerprint,
            segment_id=segment_id,
            predecessor_terminal_fingerprint=None,
        )
    )
    execution = cast(EligibleSegmentExecutionV1, prepared.execution)
    read = service_module.ReadManagedPreparedContextRequestV1(
        request_id="read.frame",
        parent_sequence_id=prepared.parent_sequence_id,
        expected_revision=prepared.revision,
        authorization_fingerprint=prepared.authorization_fingerprint,
        segment_id=segment_id,
        eligible_execution_fingerprint=execution.fingerprint,
        materialization_receipt_fingerprint=execution.materialization_receipt_fingerprint,
        context_workspace_handle=cast(str, prepared.context_workspace_handle),
    )
    result = service.read_prepared_child_context(read)
    wire = result.to_wire()
    assert wire["schema"] == "h3.context.managed_prepared_context.v2"
    assert wire["sequence_task_mode"] == "fl2va" and wire["geometry_donor_asset_id"] is None
    assert wire["media_bindings"] == bindings.to_wire()
    assert "synthetic/source" not in repr(result)
    assert "media_bindings" not in json.dumps(
        cast(service_module._ServiceEntry, service._entry).sequence.to_wire()
    )


def test_start_binding_wire_is_closed_and_crop_depth_does_not_relax_other_actions() -> None:
    _service, request, qualification, bindings, *_ = frame_start_fixture()
    payload = cast(dict[str, Any], request.to_wire())
    payload.pop("schema")
    payload.pop("request_id")
    payload.update(
        media_bindings=bindings.to_wire(), qualification_fingerprint=qualification.fingerprint
    )
    envelope = {
        "schema": service_module.MANAGED_SEQUENCE_ACTION_SCHEMA,
        "request_id": request.request_id,
        "action": "start_sequence",
        "payload": payload,
    }
    decoded = service_module.decode_managed_sequence_action_json(json.dumps(envelope).encode())
    decoded_request = cast(service_module.StartManagedSequenceRequestV1, decoded.request)
    assert (
        cast(SequenceMediaBindingSetV1, decoded_request.media_bindings).to_wire()
        == bindings.to_wire()
    )
    payload["media_bindings"]["foreign"] = True
    with pytest.raises(service_module.ManagedSequenceServiceError):
        service_module.decode_managed_sequence_action_json(json.dumps(envelope).encode())


def _nested(depth: int) -> object:
    value: object = 0
    for _ in range(depth):
        value = {"nested": value}
    return value


@pytest.mark.parametrize(
    "action",
    [
        "authorize_sequence",
        "start_sequence",
        "prepare_sequence_child",
        "bind_prepared_child",
        "fail_prepared_child",
        "fail_bound_child",
        "record_submission",
        "record_running",
        "record_artifact",
        "record_terminal",
        "record_reuse",
        "detach_client",
        "resume_sequence",
        "retry_segment",
        "cancel_sequence",
        "read_prepared_child_context",
    ],
)
def test_binding_depth_allowance_is_scoped_to_start_binding_member(action: str) -> None:
    # Shape validation runs before closed-field decoding, so this tests the real depth guard
    # independently of a later unknown-field refusal hiding a globally relaxed depth limit.
    envelope = {
        "schema": service_module.MANAGED_SEQUENCE_ACTION_SCHEMA,
        "request_id": "depth.probe",
        "action": action,
        "payload": {"media_bindings": {}, "outside_binding": _nested(4)},
    }
    with pytest.raises(ValueError, match="managed sequence JSON depth"):
        service_module.decode_managed_sequence_action_json(json.dumps(envelope).encode())


def test_start_without_binding_retains_old_depth_and_binding_refuses_depth_plus_one() -> None:
    envelope = {
        "schema": service_module.MANAGED_SEQUENCE_ACTION_SCHEMA,
        "request_id": "depth.probe",
        "action": "start_sequence",
        "payload": {"outside_binding": _nested(4)},
    }
    with pytest.raises(ValueError, match="managed sequence JSON depth"):
        service_module.decode_managed_sequence_action_json(json.dumps(envelope).encode())
    envelope["payload"] = {"media_bindings": _nested(6)}
    with pytest.raises(ValueError, match="managed sequence JSON depth"):
        service_module.decode_managed_sequence_action_json(json.dumps(envelope).encode())
