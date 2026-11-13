"""Content-free role-keyed observations for private retained sequence sources."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import cast

from ..core.contracts import AssetRole
from .comfyui_input_geometry import GeometryPreflightError, InputGeometryReceipt
from .sequence_media_bindings import (
    SequenceMediaBindingError,
    SequenceMediaBindingSetV1,
    _closed,
    _identifier,
)

SEQUENCE_PREPARED_GRAPH_OBSERVATION_SCHEMA = "h3.context.prepared_graph_observation.v5"


@dataclass(frozen=True, slots=True)
class SequenceMediaSourceIdentityV1:
    asset_id: str
    role: AssetRole
    source_identity: InputGeometryReceipt

    def __post_init__(self) -> None:
        _identifier(self.asset_id)
        if (
            self.role not in {AssetRole.FIRST_FRAME, AssetRole.LAST_FRAME}
            or type(self.source_identity) is not InputGeometryReceipt
        ):
            raise SequenceMediaBindingError("sequence_media_binding_invalid")

    @classmethod
    def from_wire(cls, value: object) -> SequenceMediaSourceIdentityV1:
        # IMPORTANT: flat rows preserve the existing depth-5 control-message bound. Private
        # crop/locator state belongs only to Start and prepared execution responses.
        wire = _closed(value, {"asset_id", "role", "receipt_handle", "source_fingerprint"})
        try:
            return cls(
                cast(str, wire["asset_id"]),
                AssetRole(wire["role"]),
                InputGeometryReceipt.from_wire(
                    {
                        "schema": "h3.context.input_geometry.receipt.v2",
                        "receipt_handle": wire["receipt_handle"],
                        "source_fingerprint": wire["source_fingerprint"],
                    }
                ),
            )
        except (ValueError, TypeError) as exc:
            raise SequenceMediaBindingError("sequence_media_binding_invalid") from exc

    def to_wire(self) -> dict[str, object]:
        return {
            "asset_id": self.asset_id,
            "role": self.role.value,
            "receipt_handle": self.source_identity.receipt_handle,
            "source_fingerprint": self.source_identity.source_fingerprint,
        }


def decode_sequence_media_identities(value: object) -> tuple[SequenceMediaSourceIdentityV1, ...]:
    if type(value) is not list or len(value) > 3:
        raise SequenceMediaBindingError("sequence_media_binding_invalid")
    rows = tuple(SequenceMediaSourceIdentityV1.from_wire(row) for row in value)
    if len({row.asset_id for row in rows}) != len(rows):
        raise SequenceMediaBindingError("sequence_media_binding_invalid")
    return rows


def validate_sequence_media_observation(
    expected: SequenceMediaBindingSetV1 | None,
    rows: tuple[SequenceMediaSourceIdentityV1, ...],
    binding_fingerprint: str | None,
) -> None:
    if (
        type(rows) is not tuple
        or any(type(row) is not SequenceMediaSourceIdentityV1 for row in rows)
        or len(rows) > 3
        or len({row.asset_id for row in rows}) != len(rows)
    ):
        raise SequenceMediaBindingError("sequence_media_changed", 409)
    entries = () if expected is None else expected.entries
    if binding_fingerprint != (None if expected is None else expected.fingerprint) or len(
        entries
    ) != len(rows):
        raise SequenceMediaBindingError("sequence_media_changed", 409)
    by_id = {row.asset_id: row for row in rows}
    # CRITICAL: validate the complete set before consuming any one-shot receipt. A wrong file
    # or role must not leave a partially claimed child or borrow another asset's identity.
    if any(
        row.asset_id not in by_id
        or by_id[row.asset_id].role is not row.role
        or by_id[row.asset_id].source_identity.source_fingerprint
        != row.source_identity.source_fingerprint
        for row in entries
    ):
        raise SequenceMediaBindingError("sequence_media_changed", 409)


def claim_sequence_media_sources(
    expected: SequenceMediaBindingSetV1 | None,
    rows: tuple[SequenceMediaSourceIdentityV1, ...],
    binding_fingerprint: str | None,
    claimant: Callable[..., InputGeometryReceipt],
) -> tuple[InputGeometryReceipt, ...]:
    validate_sequence_media_observation(expected, rows, binding_fingerprint)
    by_id = {row.asset_id: row.source_identity for row in rows}
    claimed = []
    try:
        for row in () if expected is None else expected.entries:
            receipt = by_id[row.asset_id]
            result = claimant(receipt.to_wire(), locator=row.locator)
            if type(result) is not InputGeometryReceipt or result != receipt:
                raise SequenceMediaBindingError("sequence_media_changed", 409)
            claimed.append(result)
    except GeometryPreflightError as exc:
        cause = exc.__cause__
        missing = exc.code in {"input_unavailable", "geometry_receipt_stale"} or (
            isinstance(cause, GeometryPreflightError) and cause.code == "input_unavailable"
        )
        raise SequenceMediaBindingError(
            "sequence_media_unavailable" if missing else "sequence_media_changed", 409
        ) from exc
    return tuple(claimed)
