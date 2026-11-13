"""Role-keyed private-sequence observation contracts and source-claim regressions."""

from copy import deepcopy
from pathlib import Path
from typing import Any, cast

import pytest
from test_m26_04_managed_sequence_service import _child_observation
from test_sequence_media_bindings import set_wire

from comfyui_h3_context.adapters import sequence_media_bindings as bindings
from comfyui_h3_context.adapters.comfyui_input_geometry import InputGeometryReceipt
from comfyui_h3_context.adapters.comfyui_sequence_coordinator import PreparedGraphObservation
from comfyui_h3_context.adapters.managed_sequence_service import ManagedPreparedGraphObservationV1


def observation_wire() -> tuple[bindings.SequenceMediaBindingSetV1, dict[str, Any]]:
    expected = bindings.SequenceMediaBindingSetV1.from_wire(set_wire(count=2))
    wire = cast(dict[str, Any], _child_observation("segment1").to_wire())
    wire.pop("source_identity")
    wire.update(
        schema="h3.context.prepared_graph_observation.v5",
        media_binding_fingerprint=expected.fingerprint,
        source_identities=[
            dict(
                asset_id=row.asset_id,
                role=row.role.value,
                receipt_handle=row.source_identity.receipt_handle,
                source_fingerprint=row.source_identity.source_fingerprint,
            )
            for row in expected.entries
        ],
    )
    return expected, wire


@pytest.mark.parametrize("decoder", [ManagedPreparedGraphObservationV1, PreparedGraphObservation])
def test_role_keyed_observation_closed_roundtrip_without_private_media(
    decoder: type[ManagedPreparedGraphObservationV1] | type[PreparedGraphObservation],
) -> None:
    expected, wire = observation_wire()
    value = decoder.from_wire(wire)
    assert value.to_wire() == wire
    assert "locator" not in repr(value) and "ImageCropV2" not in repr(value)
    for bad in [dict(wire, source_identity=None), dict(wire, foreign=True)]:
        with pytest.raises(ValueError):
            decoder.from_wire(bad)
    changed = deepcopy(wire)
    changed["source_identities"][0]["locator"] = "private-marker"
    with pytest.raises(ValueError):
        decoder.from_wire(changed)


def test_role_observation_claims_every_exact_locator_and_rejects_changed_identity() -> None:
    from comfyui_h3_context.adapters.sequence_media_observation import (
        SequenceMediaSourceIdentityV1,
        claim_sequence_media_sources,
    )

    expected, wire = observation_wire()
    rows = tuple(SequenceMediaSourceIdentityV1.from_wire(row) for row in wire["source_identities"])
    calls = []

    def claimant(receipt: object, *, locator: str) -> InputGeometryReceipt:
        calls.append(locator)
        from comfyui_h3_context.adapters.comfyui_input_geometry import InputGeometryReceipt

        return InputGeometryReceipt.from_wire(receipt)

    claim_sequence_media_sources(expected, rows, expected.fingerprint, claimant)
    assert calls == [row.locator for row in expected.entries]
    wire["source_identities"][0]["source_fingerprint"] = "sha256:" + "f" * 64
    changed = tuple(
        SequenceMediaSourceIdentityV1.from_wire(row) for row in wire["source_identities"]
    )
    calls.clear()
    with pytest.raises(bindings.SequenceMediaBindingError, match="sequence_media_changed"):
        claim_sequence_media_sources(expected, changed, expected.fingerprint, claimant)
    assert not calls


def test_spent_start_receipt_cannot_replace_a_fresh_child_claim(tmp_path: Path) -> None:
    from test_m23_18_input_geometry import _png, _registry, _request

    from comfyui_h3_context.adapters.sequence_media_observation import (
        SequenceMediaSourceIdentityV1,
        claim_sequence_media_sources,
    )

    root = tmp_path / "input"
    source = root / "synthetic/source0.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(_png(32, 32))
    registry = _registry(root)
    receipt = registry.observe(_request("synthetic/source0.png"))
    registry.claim(receipt.to_wire(), locator="synthetic/source0.png")
    raw = set_wire(count=1)
    raw["entries"][0]["source_identity"] = receipt.to_wire()
    expected = bindings.SequenceMediaBindingSetV1.from_wire(raw)
    row = expected.entries[0]
    identities = (SequenceMediaSourceIdentityV1(row.asset_id, row.role, receipt),)
    with pytest.raises(bindings.SequenceMediaBindingError, match="sequence_media_unavailable"):
        claim_sequence_media_sources(expected, identities, expected.fingerprint, registry.claim)


@pytest.mark.parametrize("failed", [False, True])
def test_real_reserved_coordinator_claims_sequence_source_before_child_creation(
    tmp_path: Path, failed: bool
) -> None:
    from dataclasses import replace

    from test_managed_child_response import _original_child

    from comfyui_h3_context.adapters.comfyui_input_geometry import (
        GeometryPreflightError,
        InputGeometryReceipt,
    )
    from comfyui_h3_context.adapters.managed_sequence_service import ManagedSequenceServiceError
    from comfyui_h3_context.core.contracts import TaskMode

    coordinator, request, _authority = _original_child(tmp_path, 2)
    expected = bindings.SequenceMediaBindingSetV1.from_wire(set_wire(count=1))
    row = expected.entries[0]
    wire = request.observation.to_wire()
    wire.pop("source_identity")
    wire.update(
        schema="h3.context.prepared_graph_observation.v5",
        media_binding_fingerprint=expected.fingerprint,
        source_identities=[
            dict(
                asset_id=row.asset_id,
                role=row.role.value,
                receipt_handle=row.source_identity.receipt_handle,
                source_fingerprint=row.source_identity.source_fingerprint,
            )
        ],
    )
    request = replace(
        request,
        observation=ManagedPreparedGraphObservationV1.from_wire(wire),
        sequence_task_mode=TaskMode.I2VA,
        sequence_media_bindings=expected,
    )
    calls = []

    def claim(receipt: object, *, locator: str) -> InputGeometryReceipt:
        calls.append(locator)
        if failed:
            raise GeometryPreflightError("input_changed", 409)
        return InputGeometryReceipt.from_wire(receipt)

    coordinator._sequence_media_claimant = claim
    if failed:
        with pytest.raises(ManagedSequenceServiceError, match="sequence_media_changed"):
            coordinator.bind_managed_sequence_child(request)
        assert not coordinator._runs
    else:
        result = coordinator.bind_managed_sequence_child(request)
        assert len(coordinator._runs) == 1
        result.rollback()
    assert calls == [row.locator]


@pytest.mark.parametrize(
    "change, code",
    [("replace", "sequence_media_changed"), ("delete", "sequence_media_unavailable")],
)
def test_real_file_change_between_observation_and_reserved_child_claim(
    tmp_path: Path, change: str, code: str
) -> None:
    from dataclasses import replace

    from test_m23_18_input_geometry import _png, _registry, _request
    from test_managed_child_response import _original_child

    from comfyui_h3_context.adapters.managed_sequence_service import ManagedSequenceServiceError
    from comfyui_h3_context.core.contracts import TaskMode

    coordinator, request, _authority = _original_child(tmp_path, 2)
    root = tmp_path / "input"
    source = root / "synthetic/source0.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(_png(32, 32))
    registry = _registry(root)
    receipt = registry.observe(_request("synthetic/source0.png"))
    raw = set_wire(count=1)
    raw["entries"][0]["source_identity"] = receipt.to_wire()
    expected = bindings.SequenceMediaBindingSetV1.from_wire(raw)
    row = expected.entries[0]
    wire = request.observation.to_wire()
    wire.pop("source_identity")
    wire.update(
        schema="h3.context.prepared_graph_observation.v5",
        media_binding_fingerprint=expected.fingerprint,
        source_identities=[
            dict(
                asset_id=row.asset_id,
                role=row.role.value,
                receipt_handle=receipt.receipt_handle,
                source_fingerprint=receipt.source_fingerprint,
            )
        ],
    )
    request = replace(
        request,
        observation=ManagedPreparedGraphObservationV1.from_wire(wire),
        sequence_task_mode=TaskMode.I2VA,
        sequence_media_bindings=expected,
    )
    coordinator._sequence_media_claimant = registry.claim
    if change == "replace":
        replacement = source.with_suffix(".replacement")
        replacement.write_bytes(_png(64, 32))
        replacement.replace(source)
    else:
        source.unlink()
    with pytest.raises(ManagedSequenceServiceError, match=code):
        coordinator.bind_managed_sequence_child(request)
    assert not coordinator._runs
