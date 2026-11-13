"""A client display reason may pause a held child, never grant authority."""

import json
from collections.abc import Callable
from typing import Any, cast

import pytest
from test_sequence_media_results import prepared_frame

from comfyui_h3_context.adapters import managed_sequence_service as m
from comfyui_h3_context.core.managed_sequence import EligibleSegmentExecutionV1


def action(bind: m.BindManagedSequenceChildRequestV1, code: str | None = None) -> dict[str, Any]:
    payload = dict(
        parent_sequence_id=bind.parent_sequence_id,
        expected_revision=bind.expected_revision,
        authorization_fingerprint=bind.authorization_fingerprint,
        segment_id=bind.segment_id,
        eligible_execution_fingerprint=bind.eligible_execution_fingerprint,
        failure_fingerprint="sha256:" + "c" * 64,
    )
    if code is not None:
        payload["failure_code"] = code
    return dict(
        schema=m.MANAGED_SEQUENCE_ACTION_SCHEMA,
        request_id="fail.prepared.media",
        action="fail_prepared_child",
        payload=payload,
    )


def decode(wire: object) -> m.FailPreparedManagedSequenceChildRequestV1:
    return cast(
        m.FailPreparedManagedSequenceChildRequestV1,
        m.decode_managed_sequence_action_json(json.dumps(wire).encode()).request,
    )


@pytest.mark.parametrize("code", ["sequence_media_changed", "sequence_media_unavailable"])
def test_prebind_media_failure_pauses_releases_and_replays_without_child_authority(
    code: str,
) -> None:
    service, _started, bind = prepared_frame()
    held = cast(m._HeldMaterialization, cast(m._ServiceEntry, service._entry).held_materialization)
    binder_calls: list[m.ManagedChildBindingRequestV1] = []
    service._bind_child = cast(
        Callable[[m.ManagedChildBindingRequestV1], m.ManagedChildBindingClaimV1],
        lambda request: binder_calls.append(request),
    )
    request = decode(action(bind, code))
    result = service.fail_prepared_child(request)
    assert (
        result.state.value == "paused_failure"
        and cast(m.ManagedSequenceMutationResultV2, result).failure_code == code
    )
    assert held.released and cast(m._ServiceEntry, service._entry).held_materialization is None
    assert not binder_calls and result.child_authority is None
    assert service.fail_prepared_child(request).to_wire() == {**result.to_wire(), "replayed": True}
    assert cast(m._ServiceEntry, service._entry).sequence.revision == bind.expected_revision + 1


def test_client_reason_changes_only_display_not_compile_failure_lifecycle() -> None:
    outcomes = []
    for code in [None, "sequence_media_changed", "sequence_media_unavailable"]:
        service, _started, bind = prepared_frame()
        held = cast(
            m._HeldMaterialization, cast(m._ServiceEntry, service._entry).held_materialization
        )
        result = service.fail_prepared_child(decode(action(bind, code)))
        wire = result.to_wire()
        assert wire.pop("failure_code") == code
        # Identical opaque compile-failure fingerprint and authority on all three runs.
        outcomes.append(
            (
                wire,
                cast(m._ServiceEntry, service._entry).sequence,
                held.released,
                cast(m._ServiceEntry, service._entry).bound_child_binding,
            )
        )
    assert outcomes[0] == outcomes[1] == outcomes[2]


@pytest.mark.parametrize("defect", ["null", "unknown", "extra", "revision", "execution"])
def test_prebind_failure_refuses_invalid_wire_or_authority_without_mutation(defect: str) -> None:
    service, _started, bind = prepared_frame()
    wire = action(bind, "sequence_media_changed")
    if defect == "null":
        wire["payload"]["failure_code"] = None
    if defect == "unknown":
        wire["payload"]["failure_code"] = "foreign_code"
    if defect == "extra":
        wire["payload"]["unexpected"] = True
    if defect == "revision":
        wire["payload"]["expected_revision"] -= 1
    if defect == "execution":
        wire["payload"]["eligible_execution_fingerprint"] = "sha256:" + "d" * 64
    before = cast(m._ServiceEntry, service._entry).sequence
    held = cast(m._HeldMaterialization, cast(m._ServiceEntry, service._entry).held_materialization)
    with pytest.raises(m.ManagedSequenceServiceError):
        service.fail_prepared_child(decode(wire))
    assert (
        cast(m._ServiceEntry, service._entry).sequence is before
        and cast(m._ServiceEntry, service._entry).held_materialization is held
        and not held.released
    )


def t2va_prepared() -> tuple[m.ManagedSequenceService, m.ManagedSequenceMutationResultV1]:
    from test_m26_04_managed_sequence_service import _fp, _service, _started

    def materialize(_authority: object, segment: str) -> m.ManagedSegmentMaterializationClaimV1:
        return m.ManagedSegmentMaterializationClaimV1(
            context_workspace_handle="ws_" + "c" * 40,
            segment_id=segment,
            materialization_receipt_fingerprint=_fp("materialization.1"),
            release=lambda: None,
        )

    service, _production = _service(materialize=materialize)
    authorized, _authority, started = _started(service)
    prepared = service.prepare_child(
        m.PrepareManagedSequenceChildRequestV1(
            request_id="prepare.t2va",
            parent_sequence_id=authorized.parent_sequence_id,
            expected_revision=started.revision,
            authorization_fingerprint=authorized.authorization_fingerprint,
            segment_id="segment.1",
            predecessor_terminal_fingerprint=None,
        )
    )
    return service, prepared


@pytest.mark.parametrize("code", ["sequence_media_changed", "sequence_media_unavailable"])
def test_t2va_refuses_a_media_reason_without_mutation(code: str) -> None:
    service, prepared = t2va_prepared()
    payload = dict(
        parent_sequence_id=prepared.parent_sequence_id,
        expected_revision=prepared.revision,
        authorization_fingerprint=prepared.authorization_fingerprint,
        segment_id="segment.1",
        eligible_execution_fingerprint=cast(
            EligibleSegmentExecutionV1, prepared.execution
        ).fingerprint,
        failure_fingerprint="sha256:" + "c" * 64,
        failure_code=code,
    )
    wire = dict(
        schema=m.MANAGED_SEQUENCE_ACTION_SCHEMA,
        request_id="failure.t2va",
        action="fail_prepared_child",
        payload=payload,
    )
    before = cast(m._ServiceEntry, service._entry).sequence
    with pytest.raises(m.ManagedSequenceServiceError, match="invalid_prepared_failure_code"):
        service.fail_prepared_child(decode(wire))
    assert (
        cast(m._ServiceEntry, service._entry).sequence is before
        and not cast(
            m._HeldMaterialization, cast(m._ServiceEntry, service._entry).held_materialization
        ).released
    )


def test_absent_field_t2va_wire_remains_exact() -> None:
    service, prepared = t2va_prepared()
    authority = m.ManagedSequenceMutationAuthorityV1(
        request_id="failure.t2va",
        parent_sequence_id=prepared.parent_sequence_id,
        expected_revision=prepared.revision,
        authorization_fingerprint=prepared.authorization_fingerprint,
    )
    request = m.FailPreparedManagedSequenceChildRequestV1(
        authority,
        "segment.1",
        cast(EligibleSegmentExecutionV1, prepared.execution).fingerprint,
        "sha256:" + "c" * 64,
    )
    assert request.to_wire() == dict(
        schema=m.MANAGED_SEQUENCE_ACTION_SCHEMA,
        request_id="failure.t2va",
        parent_sequence_id=prepared.parent_sequence_id,
        expected_revision=prepared.revision,
        authorization_fingerprint=prepared.authorization_fingerprint,
        segment_id="segment.1",
        eligible_execution_fingerprint=cast(
            EligibleSegmentExecutionV1, prepared.execution
        ).fingerprint,
        failure_fingerprint="sha256:" + "c" * 64,
    )
    assert "failure_code" not in service.fail_prepared_child(request).to_wire()


def test_maximum_prebind_failure_request_stays_in_unchanged_control_budget() -> None:
    payload = dict(
        parent_sequence_id="p" * 128,
        expected_revision=1_000_000,
        authorization_fingerprint="sha256:" + "a" * 64,
        segment_id="s" * 128,
        eligible_execution_fingerprint="sha256:" + "b" * 64,
        failure_fingerprint="sha256:" + "c" * 64,
        failure_code="sequence_media_unavailable",
    )
    wire = dict(
        schema=m.MANAGED_SEQUENCE_ACTION_SCHEMA,
        request_id="r" * 128,
        action="fail_prepared_child",
        payload=payload,
    )
    raw = json.dumps(wire, ensure_ascii=False, separators=(",", ":")).encode()
    assert decode(wire).failure_code == "sequence_media_unavailable"
    assert len(raw) <= 8192
    print("maximum_prebind_failure_request_utf8_bytes", len(raw))
