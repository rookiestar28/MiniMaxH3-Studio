"""Scoped structural compatibility of the loaded native source.

The admission is computed from the loaded bytes at qualification time (`native_t2va_structure`),
never from a host version, revision or blob allowlist. The raw blob stays a currentness identity:
any byte change invalidates an issued receipt, and only a fresh observation may admit again.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast

from .canonical import canonical_fingerprint
from .contracts import MediaKind, TaskMode
from .native_guide import NativeGuideCapability
from .native_h3 import NATIVE_H3_HOST_REVISION, NATIVE_H3_SOURCE_BLOB, NativeH3Wiring
from .native_keyframe_structure import (
    NativeKeyframeStructureVerdict,
)
from .native_keyframe_structure import (
    is_production_admission as is_keyframe_admission,
)
from .native_t2va_structure import (
    PRODUCTION_MANIFEST,
    NativeT2VAStructureVerdict,
    is_production_admission,
)


@dataclass(frozen=True, slots=True)
class NativeSourceObservation:
    """One bounded read of the registered native module.

    The blob and the structural verdict derive from the same byte buffer. `_origin` holds the
    registered module, class objects and source location for in-process identity comparison;
    it is never serialized, hashed into a wire or shown to a browser.
    """

    source_blob: str
    structure: NativeT2VAStructureVerdict
    _origin: tuple[object, ...] = field(repr=False)
    keyframes: NativeKeyframeStructureVerdict | None = None
    guide: NativeGuideCapability | None = None


@dataclass(frozen=True, slots=True)
class NativeSourceCompatibilityV2:
    """A receipt bound to the ORIGINAL observation it was minted from, never re-minted."""

    _source: NativeSourceObservation = field(repr=False)
    scope: str = "structural_t2va_without_bindings"

    def admits(self, source: NativeSourceObservation | None, wiring: NativeH3Wiring) -> bool:
        # CRITICAL: compare the ORIGINAL observation and its own audited scope. A T2VA
        # verdict masks media bodies and must never grant keyframe or reference execution.
        current = (
            type(self) is NativeSourceCompatibilityV2
            and type(source) is NativeSourceObservation
            and type(self._source) is NativeSourceObservation
            and source == self._source
            and source.source_blob != NATIVE_H3_SOURCE_BLOB
            and wiring.native_source_blob == NATIVE_H3_SOURCE_BLOB
            and wiring.host_revision == NATIVE_H3_HOST_REVISION
        )
        if not current:
            return False
        source = cast(NativeSourceObservation, source)
        if self.scope == "structural_t2va_without_bindings":
            return (
                is_production_admission(source.structure)
                and wiring.task_mode is TaskMode.T2VA
                and not wiring.bindings
            )
        expected = {
            TaskMode.I2VA: frozenset({"first_frame"}),
            TaskMode.L2VA: frozenset({"last_frame"}),
            TaskMode.FL2VA: frozenset({"first_frame", "last_frame"}),
        }.get(wiring.task_mode)
        return (
            self.scope == "structural_keyframe"
            and expected is not None
            and len(wiring.bindings) == len(expected)
            and frozenset(row.native_input for row in wiring.bindings) == expected
            and all(row.kind is MediaKind.IMAGE for row in wiring.bindings)
            and is_keyframe_admission(source.keyframes)
            and type(source.guide) is NativeGuideCapability
            and source.guide.admitted
        )

    @property
    def fingerprint(self) -> str:
        verdict = (
            cast(NativeKeyframeStructureVerdict, self._source.keyframes)
            if self.scope == "structural_keyframe"
            else self._source.structure
        )
        wire = {
            "schema": "h3.native_source_compatibility.v2",
            "classifier_schema": verdict.classifier_schema,
            "manifest_fingerprint": verdict.manifest_fingerprint,
            "source_blob": self._source.source_blob,
            "baseline_blob": NATIVE_H3_SOURCE_BLOB,
            "scope": self.scope,
        }
        if self.scope == "structural_keyframe":
            wire["guide_capability_fingerprint"] = cast(
                NativeGuideCapability, self._source.guide
            ).fingerprint
        return canonical_fingerprint(wire)


def qualify_native_source_compatibility(
    source: NativeSourceObservation | None, wiring: NativeH3Wiring
) -> NativeSourceCompatibilityV2 | None:
    """Mint a receipt for a structurally admitted non-baseline source; the baseline needs none."""
    if type(source) is not NativeSourceObservation or source.source_blob == NATIVE_H3_SOURCE_BLOB:
        return None
    scope = (
        "structural_keyframe"
        if wiring.task_mode in {TaskMode.I2VA, TaskMode.L2VA, TaskMode.FL2VA}
        else "structural_t2va_without_bindings"
    )
    receipt = NativeSourceCompatibilityV2(source, scope)
    return receipt if receipt.admits(source, wiring) else None


__all__ = [
    "PRODUCTION_MANIFEST",
    "NativeSourceCompatibilityV2",
    "NativeSourceObservation",
    "qualify_native_source_compatibility",
]
