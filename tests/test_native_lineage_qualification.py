"""Qualification of a loaded native source on each production lineage, and the unrecognized hold.

These are model-free: a source observation stands in for what the registered-module observer
classified, and the verdicts carry a production lineage's real fingerprint. They prove that every
native mode qualifies on the original lineage and on the newer one, that a receipt minted under
one lineage is not the other's, and that the closed public reason for a source no lineage admits
covers exactly the two structural refusals and nothing else.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any, cast

import pytest
from native_source_doubles import EQUIVALENT_BLOB, observed_source
from test_native_h3_adapter import (
    _audio_only_reference_report,
    _keyframe_report,
    _report,
    _single_keyframe_report,
)
from test_native_source_compatibility import _qualify

from comfyui_h3_context.adapters import managed_mode_qualification as producer_module
from comfyui_h3_context.core import native_keyframe_structure as keyframe_structure
from comfyui_h3_context.core.contracts import TaskMode
from comfyui_h3_context.core.native_guide import GUIDE_REQUIRED_INPUTS, NativeGuideCapability
from comfyui_h3_context.core.native_h3 import build_native_h3_wiring
from comfyui_h3_context.core.native_source_compatibility import (
    NativeSourceObservation,
    qualify_native_source_compatibility,
)
from comfyui_h3_context.core.native_t2va_structure import StructureReason

MODES = ("t2va", "i2va", "l2va", "fl2va")
LINEAGES = (0, 1)
_SCOPES = {
    "t2va": "structural_t2va_without_bindings",
    "i2va": "structural_keyframe",
    "l2va": "structural_keyframe",
    "fl2va": "structural_keyframe",
}


def _report_for(mode: str) -> Any:
    if mode == "t2va":
        return _report()
    if mode == "fl2va":
        return _keyframe_report()
    return _single_keyframe_report(TaskMode[mode.upper()])


def _source_for(mode: str, lineage: int, *, admitted: bool = True) -> NativeSourceObservation:
    """A non-baseline source whose verdict for `mode`'s scope is against one production lineage."""
    check = "admitted" if admitted else "definition:FPS"
    base = cast(
        NativeSourceObservation, observed_source(EQUIVALENT_BLOB, check=check, lineage=lineage)
    )
    if mode == "t2va":
        return base
    return replace(
        base,
        keyframes=keyframe_structure.NativeKeyframeStructureVerdict(
            keyframe_structure.KeyframeStructureReason.ADMITTED
            if admitted
            else keyframe_structure.KeyframeStructureReason.CHANGED,
            "admitted" if admitted else "definition:MiniMaxH3ImageToVideo.execute",
            keyframe_structure.PRODUCTION_LINEAGES[lineage].fingerprint,
        ),
        guide=NativeGuideCapability(True, GUIDE_REQUIRED_INPUTS),
    )


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("lineage", LINEAGES)
def test_every_native_mode_qualifies_on_each_production_lineage(mode: str, lineage: int) -> None:
    report = _report_for(mode)
    wiring = build_native_h3_wiring(report)
    source = _source_for(mode, lineage)
    receipt = qualify_native_source_compatibility(source, wiring)
    assert receipt is not None and receipt.scope == _SCOPES[mode]
    assert receipt.admits(source, wiring)
    qualified = _qualify([source], report=report, wiring=wiring, receipt=receipt)
    assert qualified.qualified and qualified.detail == "structural_receipt"
    qualified.assert_current(report, wiring)


@pytest.mark.parametrize("mode", MODES)
def test_a_receipt_minted_under_one_lineage_is_not_the_others(mode: str) -> None:
    wiring = build_native_h3_wiring(_report_for(mode))
    first = qualify_native_source_compatibility(_source_for(mode, 0), wiring)
    second = qualify_native_source_compatibility(_source_for(mode, 1), wiring)
    assert first is not None and second is not None
    assert first.fingerprint != second.fingerprint
    # The receipt binds the lineage its verdict was classified against: neither admits the other's
    # observation, so a currentness check can never swap the lineage underneath a qualification.
    assert not first.admits(_source_for(mode, 1), wiring)
    assert not second.admits(_source_for(mode, 0), wiring)


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("lineage", LINEAGES)
def test_a_source_no_lineage_admits_is_held_with_a_structure_reason(
    mode: str, lineage: int
) -> None:
    report = _report_for(mode)
    wiring = build_native_h3_wiring(report)
    source = _source_for(mode, lineage, admitted=False)
    assert qualify_native_source_compatibility(source, wiring) is None
    held = _qualify([source], report=report, wiring=wiring)
    assert not held.qualified
    assert held.reason in producer_module._UNRECOGNIZED_SOURCE_COMPOSITION_REASONS
    # The detail is a closed manifest identifier, never source text or a path.
    assert held.detail is not None and held.detail.startswith("definition:")


def test_the_unrecognized_reason_covers_exactly_the_two_structural_refusals() -> None:
    assert producer_module._UNRECOGNIZED_SOURCE_COMPOSITION_REASONS == {
        StructureReason.CHANGED.value,
        keyframe_structure.KeyframeStructureReason.CHANGED.value,
    }


def test_other_composition_holds_keep_the_generic_reason() -> None:
    unrecognized = producer_module._UNRECOGNIZED_SOURCE_COMPOSITION_REASONS
    # No source observation at all: the workflow is not there to compare.
    unavailable = _qualify([None])
    assert unavailable.reason == "native_source_identity_mismatch"
    assert unavailable.detail == "source_unavailable"
    assert unavailable.reason not in unrecognized
    # A non-baseline source with no verdict for the mode's scope is never promoted or named.
    base = cast(NativeSourceObservation, observed_source(EQUIVALENT_BLOB))
    keyframe_report = _keyframe_report()
    absent = _qualify(
        [base], report=keyframe_report, wiring=build_native_h3_wiring(keyframe_report)
    )
    assert (absent.reason, absent.detail) == ("native_source_identity_mismatch", "receipt_absent")
    assert absent.reason not in unrecognized
    # An audio-bearing reference set is held whatever the structure says, so it never reads as an
    # unrecognized version either.
    audio_report = _audio_only_reference_report()
    audio_source = _source_for("t2va", 1, admitted=False)
    audio = _qualify(
        [audio_source], report=audio_report, wiring=build_native_h3_wiring(audio_report)
    )
    assert audio.reason not in unrecognized
