"""Closed, volatile execution bindings. Never embed these values in durable state.

Only the loopback Start and prepared-child execution wires carry locators or crops. The parent
owner stores immutable entries, not serialized responses; its slot and entry-byte reservations
are independent of the coordinator's unchanged control-response ledger.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import cast

from ..core.canonical import canonical_fingerprint
from ..core.contracts import AssetRole, MediaKind
from ..core.managed_sequence import MAX_SEQUENCE_MEDIA_BINDING_BYTES, MAX_SEQUENCE_MEDIA_BINDINGS
from ..core.registry import ReferenceRegistry
from .comfyui_input_geometry import GeometryPreflightError, InputGeometryReceipt, _locator_parts

SEQUENCE_MEDIA_BINDING_SET_SCHEMA = "h3.context.sequence_media_binding_set.v1"
SEQUENCE_MEDIA_CROP_NODE_TYPE = "ImageCropV2"
MAX_CROP_DIMENSION = 16_384
MAX_SEQUENCE_MEDIA_PARENTS = 16
MAX_RETAINED_SEQUENCE_MEDIA_BYTES = (
    MAX_SEQUENCE_MEDIA_PARENTS * MAX_SEQUENCE_MEDIA_BINDINGS * MAX_SEQUENCE_MEDIA_BINDING_BYTES
)
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")


class SequenceMediaBindingError(ValueError):
    """Closed content-free refusal; no observed value may become diagnostic text."""

    def __init__(self, code: str, status: int = 422) -> None:
        self.code, self.status = code, status
        super().__init__(code)


def _identifier(value: object) -> str:
    if type(value) is not str or _IDENTIFIER.fullmatch(value) is None:
        raise SequenceMediaBindingError("sequence_media_binding_invalid")
    return value


def _closed(value: object, keys: set[str]) -> dict[str, object]:
    if type(value) is not dict or set(value) != keys:
        raise SequenceMediaBindingError("sequence_media_binding_invalid")
    return value


def _compact_bytes(value: object) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
            "utf-8"
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise SequenceMediaBindingError("sequence_media_binding_invalid") from exc


@dataclass(frozen=True, slots=True, repr=False)
class SequenceMediaCropV1:
    node_id: str
    x: int
    y: int
    width: int
    height: int

    def __post_init__(self) -> None:
        _identifier(self.node_id)
        if (
            any(type(v) is not int for v in (self.x, self.y, self.width, self.height))
            or not 0 <= self.x <= MAX_CROP_DIMENSION
            or not 0 <= self.y <= MAX_CROP_DIMENSION
            or not 32 <= self.width <= MAX_CROP_DIMENSION
            or not 32 <= self.height <= MAX_CROP_DIMENSION
            or self.x + self.width > MAX_CROP_DIMENSION
            or self.y + self.height > MAX_CROP_DIMENSION
        ):
            raise SequenceMediaBindingError("sequence_media_binding_invalid")

    @classmethod
    def from_wire(cls, value: object) -> SequenceMediaCropV1:
        wire = _closed(value, {"node_id", "class_type", "region"})
        if wire["class_type"] != SEQUENCE_MEDIA_CROP_NODE_TYPE:
            raise SequenceMediaBindingError("sequence_media_binding_invalid")
        region = _closed(wire["region"], {"x", "y", "width", "height"})
        return cls(node_id=wire["node_id"], **region)  # type: ignore[arg-type]

    def to_wire(self) -> dict[str, object]:
        return {
            "node_id": self.node_id,
            "class_type": SEQUENCE_MEDIA_CROP_NODE_TYPE,
            "region": {"x": self.x, "y": self.y, "width": self.width, "height": self.height},
        }


@dataclass(frozen=True, slots=True, repr=False)
class SequenceRegistryEndpointV1:
    node_id: str
    input_name: str
    source_node_id: str
    source_slot: int = 0

    def __post_init__(self) -> None:
        for value in (self.node_id, self.input_name, self.source_node_id):
            _identifier(value)
        if type(self.source_slot) is not int or self.source_slot != 0:
            raise SequenceMediaBindingError("sequence_media_binding_invalid")

    @classmethod
    def from_wire(cls, value: object) -> SequenceRegistryEndpointV1:
        return cls(**_closed(value, {"node_id", "input_name", "source_node_id", "source_slot"}))  # type: ignore[arg-type]

    def to_wire(self) -> dict[str, object]:
        return {
            "node_id": self.node_id,
            "input_name": self.input_name,
            "source_node_id": self.source_node_id,
            "source_slot": self.source_slot,
        }


@dataclass(frozen=True, slots=True, repr=False)
class SequenceMediaBindingV1:
    asset_id: str
    role: AssetRole
    kind: MediaKind
    loader_class: str
    loader_node_id: str
    locator: str
    source_identity: InputGeometryReceipt
    registry_endpoint: SequenceRegistryEndpointV1
    transform: SequenceMediaCropV1 | None

    def __post_init__(self) -> None:
        _identifier(self.asset_id)
        _identifier(self.loader_node_id)
        if (
            type(self.role) is not AssetRole
            or self.kind is not MediaKind.IMAGE
            or self.loader_class != "LoadImage"
            or type(self.source_identity) is not InputGeometryReceipt
            or type(self.registry_endpoint) is not SequenceRegistryEndpointV1
            or (self.transform is not None and type(self.transform) is not SequenceMediaCropV1)
        ):
            raise SequenceMediaBindingError("sequence_media_binding_invalid")
        try:
            _locator_parts(self.locator)
        except GeometryPreflightError as exc:
            raise SequenceMediaBindingError("sequence_media_binding_invalid") from exc
        endpoint = self.transform.node_id if self.transform else self.loader_node_id
        if self.registry_endpoint.source_node_id != endpoint or (
            self.transform is not None and self.transform.node_id == self.loader_node_id
        ):
            raise SequenceMediaBindingError("sequence_media_binding_invalid")
        if len(_compact_bytes(self.to_wire())) > MAX_SEQUENCE_MEDIA_BINDING_BYTES:
            raise SequenceMediaBindingError("sequence_media_binding_size")

    @classmethod
    def from_wire(cls, value: object) -> SequenceMediaBindingV1:
        # IMPORTANT: enforce UTF-8 bytes before parsing private fields; UTF-16 character counts
        # admit oversized Unicode entries and invalidate the parent's fixed retention budget.
        try:
            if len(_compact_bytes(value)) > MAX_SEQUENCE_MEDIA_BINDING_BYTES:
                raise SequenceMediaBindingError("sequence_media_binding_size")
            wire = _closed(
                value,
                {
                    "asset_id",
                    "role",
                    "kind",
                    "loader_class",
                    "loader_node_id",
                    "locator",
                    "source_identity",
                    "registry_endpoint",
                    "transform",
                },
            )
            return cls(
                asset_id=cast(str, wire["asset_id"]),
                role=AssetRole(wire["role"]),
                kind=MediaKind(wire["kind"]),
                loader_class=cast(str, wire["loader_class"]),
                loader_node_id=cast(str, wire["loader_node_id"]),
                locator=cast(str, wire["locator"]),
                source_identity=InputGeometryReceipt.from_wire(wire["source_identity"]),
                registry_endpoint=SequenceRegistryEndpointV1.from_wire(wire["registry_endpoint"]),
                transform=None
                if wire["transform"] is None
                else SequenceMediaCropV1.from_wire(wire["transform"]),
            )
        except SequenceMediaBindingError:
            raise
        except (TypeError, ValueError) as exc:
            raise SequenceMediaBindingError("sequence_media_binding_invalid") from exc

    def to_wire(self) -> dict[str, object]:
        return {
            "asset_id": self.asset_id,
            "role": self.role.value,
            "kind": self.kind.value,
            "loader_class": self.loader_class,
            "loader_node_id": self.loader_node_id,
            "locator": self.locator,
            "source_identity": self.source_identity.to_wire(),
            "registry_endpoint": self.registry_endpoint.to_wire(),
            "transform": None if self.transform is None else self.transform.to_wire(),
        }

    @property
    def identity_wire(self) -> dict[str, object]:
        # CRITICAL: renewed receipts have new handles. The retained identity covers the file,
        # exact loader/Registry endpoint and crop, not the short-lived handle's allocation.
        wire = self.to_wire()
        locator = wire.pop("locator")
        # File locators are codepoint-exact, unlike canonical human text. Hash the raw JSON
        # string first so NFC normalization cannot merge distinct filesystem spellings.
        return {
            **wire,
            "locator_fingerprint": "sha256:" + hashlib.sha256(_compact_bytes(locator)).hexdigest(),
            "source_identity": {"source_fingerprint": self.source_identity.source_fingerprint},
        }


@dataclass(frozen=True, slots=True, repr=False)
class SequenceMediaBindingSetV1:
    entries: tuple[SequenceMediaBindingV1, ...] = field(repr=False)
    schema: str = SEQUENCE_MEDIA_BINDING_SET_SCHEMA

    def __post_init__(self) -> None:
        if (
            self.schema != SEQUENCE_MEDIA_BINDING_SET_SCHEMA
            or type(self.entries) is not tuple
            or not 1 <= len(self.entries) <= MAX_SEQUENCE_MEDIA_BINDINGS
            or any(type(row) is not SequenceMediaBindingV1 for row in self.entries)
            or len({row.asset_id for row in self.entries}) != len(self.entries)
        ):
            raise SequenceMediaBindingError("sequence_media_binding_invalid")

    @classmethod
    def from_wire(cls, value: object) -> SequenceMediaBindingSetV1:
        wire = _closed(value, {"schema", "entries"})
        rows = wire["entries"]
        if type(rows) is not list or not 1 <= len(rows) <= MAX_SEQUENCE_MEDIA_BINDINGS:
            raise SequenceMediaBindingError("sequence_media_binding_invalid")
        return cls(
            tuple(SequenceMediaBindingV1.from_wire(row) for row in rows),
            schema=cast(str, wire["schema"]),
        )

    def to_wire(self) -> dict[str, object]:
        return {"schema": self.schema, "entries": [row.to_wire() for row in self.entries]}

    @property
    def fingerprint(self) -> str:
        return canonical_fingerprint(
            {
                "schema": self.schema,
                "entries": [
                    row.identity_wire for row in sorted(self.entries, key=lambda row: row.asset_id)
                ],
            }
        )

    def validate_registry(self, registry: ReferenceRegistry, asset_ids: tuple[str, ...]) -> None:
        required = {row.asset_id: row for row in registry.assets if row.asset_id in asset_ids}
        if set(required) != set(asset_ids) or set(required) != {
            row.asset_id for row in self.entries
        }:
            raise SequenceMediaBindingError("sequence_media_binding_missing")
        for row in self.entries:
            asset = required[row.asset_id]
            if asset.role is not row.role or asset.kind is not row.kind:
                raise SequenceMediaBindingError("sequence_media_binding_invalid")


class RetainedSequenceMediaBindings:
    """One service-owned, separately bounded volatile pool; no projection/ledger writer."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._entries: dict[str, tuple[SequenceMediaBindingSetV1, float]] = {}
        self._lock = threading.RLock()

    def _prune(self) -> None:
        now = self._clock()
        for parent, (_bindings, expires) in tuple(self._entries.items()):
            if expires <= now:
                del self._entries[parent]

    def retain(
        self, parent: str, bindings: SequenceMediaBindingSetV1, *, expires_at: float
    ) -> None:
        _identifier(parent)
        if (
            type(bindings) is not SequenceMediaBindingSetV1
            or type(expires_at) not in {int, float}
            or not math.isfinite(expires_at)
            or not self._clock() < expires_at <= self._clock() + 86400
        ):
            raise SequenceMediaBindingError("sequence_media_binding_invalid")
        with self._lock:
            self._prune()
            if parent in self._entries:
                raise SequenceMediaBindingError("sequence_media_already_retained", 409)
            if len(self._entries) >= MAX_SEQUENCE_MEDIA_PARENTS:
                raise SequenceMediaBindingError("coordinator_run_capacity", 503)
            self._entries[parent] = bindings, expires_at

    def get(self, parent: str) -> SequenceMediaBindingSetV1:
        with self._lock:
            self._prune()
            entry = self._entries.get(parent)
            if entry is None:
                raise SequenceMediaBindingError("sequence_media_unavailable", 409)
            return entry[0]

    def release(self, parent: str) -> None:
        with self._lock:
            self._entries.pop(parent, None)

    @property
    def parent_count(self) -> int:
        with self._lock:
            self._prune()
            return len(self._entries)

    @property
    def reserved_bytes(self) -> int:
        # Reserve a maximum set per parent. Only entries are retained; fixed wire envelopes
        # and prepared responses are reconstructed on demand and never cached in this pool.
        return self.parent_count * MAX_SEQUENCE_MEDIA_BINDINGS * MAX_SEQUENCE_MEDIA_BINDING_BYTES
