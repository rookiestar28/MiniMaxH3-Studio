"""Model-free loaded-source observations for composition, compatibility and producer tests.

Production observations come only from the registered-module observer, which classifies the one
byte buffer it hashed. These doubles stand in for that observer's output; they never make a
synthetic source structurally admitted against the production table by themselves.
"""

from __future__ import annotations

from comfyui_h3_context.core.generation_profile import HostObservation
from comfyui_h3_context.core.native_composition import NativeCompositionObservation
from comfyui_h3_context.core.native_h3 import NATIVE_H3_SOURCE_BLOB
from comfyui_h3_context.core.native_source_compatibility import NativeSourceObservation
from comfyui_h3_context.core.native_t2va_structure import (
    PRODUCTION_LINEAGES,
    NativeT2VAStructureVerdict,
    StructureReason,
)

#: A non-baseline loaded source whose audited T2VA surface is structurally the baseline's.
EQUIVALENT_BLOB = "1baa33cb" + "0" * 32


def structure_verdict(check: str = "admitted", *, lineage: int = 0) -> NativeT2VAStructureVerdict:
    """A verdict against one production lineage (0 is the original baseline, 1 the newer shape)."""
    reason = StructureReason.ADMITTED if check == "admitted" else StructureReason.CHANGED
    return NativeT2VAStructureVerdict(reason, check, PRODUCTION_LINEAGES[lineage].fingerprint)


def observed_source(
    blob: str | None = NATIVE_H3_SOURCE_BLOB,
    *,
    check: str = "admitted",
    origin: object = "registered-module",
    lineage: int = 0,
) -> NativeSourceObservation | None:
    if blob is None:
        return None
    return NativeSourceObservation(blob, structure_verdict(check, lineage=lineage), (origin,))


def composition_observation(
    host: HostObservation | None, source: NativeSourceObservation | None
) -> NativeCompositionObservation:
    return NativeCompositionObservation(host, source)
