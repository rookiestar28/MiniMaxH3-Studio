"""Unmasked, parse-only keyframe surface checks using authored synthetic source."""

import importlib
from types import ModuleType
from typing import cast

import pytest
from native_lineage_fixtures import (
    PATTERN_LINE,
    PATTERN_NAME,
    lineage_b_definitions,
    to_lineage_b,
    variant,
)
from native_t2va_fixtures import SYNTHETIC_DEFINITIONS, SYNTHETIC_SOURCE, synthetic_manifest

from comfyui_h3_context.core import native_t2va_structure as t2va
from comfyui_h3_context.core.native_keyframe_structure import NativeKeyframeBaselineManifest

# The committed keyframe production table (lineage A); a lineage added later never moves it.
PRODUCTION_MANIFEST_FINGERPRINT = (
    "sha256:61c1ff85ea8d0f4de3d046b387770bb738705cf4e0d33cc0e4f1d290524690bf"
)
SOURCE = (
    SYNTHETIC_SOURCE
    + """

class MiniMaxH3AddGuide(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="MiniMaxH3AddGuide", inputs=[
            io.Conditioning.Input("positive"), io.Vae.Input("vae", optional=True),
            io.Latent.Input("latent"), io.Image.Input("image", optional=True),
            io.Int.Input("frame_idx", default=0, min=-9999, max=9999)])

    @classmethod
    def execute(cls, positive, latent, frame_idx, vae=None, image=None):
        count = latent["frames"]
        index = frame_idx if frame_idx >= 0 else count + frame_idx
        if index < 0 or index >= count:
            raise ValueError("invalid guide index")
        rows = list(positive[0][1].get("minimax_keyframes", []))
        rows.append({"resolved_frame_index": index, "latent": vae.encode(image[:1])})
        return io.NodeOutput(positive, rows)
"""
)
DEFINITIONS = (
    *SYNTHETIC_DEFINITIONS,
    "MiniMaxH3AddGuide.define_schema",
    "MiniMaxH3AddGuide.execute",
    "MiniMaxH3AddGuide",
)


def _module() -> ModuleType:
    return importlib.import_module("comfyui_h3_context.core.native_keyframe_structure")


def _manifest() -> NativeKeyframeBaselineManifest:
    return cast(
        NativeKeyframeBaselineManifest,
        _module().derive_keyframe_manifest(
            SOURCE.encode(),
            source_revision="synthetic",
            source_blob="1" * 40,
            definitions=DEFINITIONS,
        ),
    )


def test_keyframe_source_is_unmasked_and_never_borrows_t2va_admission() -> None:
    module = _module()
    manifest = _manifest()
    assert module._classify(SOURCE.encode(), manifest).admitted
    changed = SOURCE.replace(
        "keyframes.append((0, first_frame))", "keyframes.append((1, first_frame))"
    )
    assert t2va._classify(changed.encode(), synthetic_manifest()).admitted
    verdict = module._classify(changed.encode(), manifest)
    assert not verdict.admitted
    assert verdict.reason.value == "native_keyframe_structure_changed"
    assert verdict.check == "definition:MiniMaxH3ImageToVideo.execute"
    assert not module.is_production_admission(module._classify(SOURCE.encode(), manifest))


@pytest.mark.parametrize(
    ("old", "new", "definition"),
    (
        (
            'node_id="MiniMaxH3ImageToVideo"',
            'node_id="ChangedImageNode"',
            "MiniMaxH3ImageToVideo.define_schema",
        ),
        ("length - 1, last_frame", "length - 2, last_frame", "MiniMaxH3ImageToVideo.execute"),
        (
            'io.Image.Input("image", optional=True)',
            'io.Image.Input("different", optional=True)',
            "MiniMaxH3AddGuide.define_schema",
        ),
        ("else count + frame_idx", "else count - frame_idx", "MiniMaxH3AddGuide.execute"),
        (
            '"resolved_frame_index": index',
            '"resolved_frame_index": index + 1',
            "MiniMaxH3AddGuide.execute",
        ),
        ("vae.encode(image[:1])", "vae.encode(image[1:])", "MiniMaxH3AddGuide.execute"),
    ),
)
def test_keyframe_definition_mutants_are_named_and_bounded(
    old: str, new: str, definition: str
) -> None:
    assert SOURCE.count(old) == 1
    verdict = _module()._classify(SOURCE.replace(old, new).encode(), _manifest())
    assert not verdict.admitted
    assert verdict.reason.value == "native_keyframe_structure_changed"
    assert verdict.check == "definition:" + definition


def test_keyframe_classifier_preserves_parse_and_envelope_bounds() -> None:
    module = _module()
    for source in (b"x" * (t2va.MAX_SOURCE_BYTES + 1), b"not valid python !!!"):
        verdict = module._classify(source, _manifest())
        assert not verdict.admitted
        assert len(verdict.check) <= 128
    marker = "untrusted_marker_must_not_be_a_diagnostic"
    verdict = module._classify((SOURCE + f"\n{marker}()\n").encode(), _manifest())
    assert not verdict.admitted and marker not in verdict.check


SOURCE_B = to_lineage_b(SOURCE)


def _manifest_b() -> NativeKeyframeBaselineManifest:
    return cast(
        NativeKeyframeBaselineManifest,
        _module().derive_keyframe_manifest(
            SOURCE_B.encode(),
            source_revision="synthetic-keyframe-b",
            source_blob="2" * 40,
            definitions=lineage_b_definitions(DEFINITIONS),
        ),
    )


def test_keyframe_lineages_are_tried_in_order_and_the_first_admission_wins() -> None:
    module = _module()
    a, b = _manifest(), _manifest_b()
    assert a.fingerprint != b.fingerprint
    for order in ((a, b), (b, a)):
        older = t2va.classify_lineages(SOURCE.encode(), order, module._classify)
        newer = t2va.classify_lineages(SOURCE_B.encode(), order, module._classify)
        assert older.admitted and older.manifest_fingerprint == a.fingerprint
        assert newer.admitted and newer.manifest_fingerprint == b.fingerprint
        assert older.reason.value == "native_keyframe_structure_admitted"


def test_keyframe_refusal_comes_from_the_newest_lineage_and_stays_unmasked() -> None:
    module = _module()
    a, b = _manifest(), _manifest_b()
    changed = variant(SOURCE_B, ("(0, first_frame)", "(1, first_frame)"))
    # The T2VA scope masks this guarded body, so only the unmasked keyframe scope can refuse it.
    assert t2va._classify(changed.encode(), t2va_manifest_b()).admitted
    verdict = t2va.classify_lineages(changed.encode(), (a, b), module._classify)
    assert not verdict.admitted
    assert verdict.manifest_fingerprint == b.fingerprint
    assert verdict.check == "definition:MiniMaxH3ImageToVideo.execute"
    guide = variant(SOURCE_B, ("else count + frame_idx", "else count - frame_idx"))
    verdict = t2va.classify_lineages(guide.encode(), (a, b), module._classify)
    assert (verdict.manifest_fingerprint, verdict.check) == (
        b.fingerprint,
        "definition:MiniMaxH3AddGuide.execute",
    )


def t2va_manifest_b() -> t2va.NativeT2VABaselineManifest:
    return t2va.derive_manifest(
        SOURCE_B.encode(),
        source_revision="synthetic-t2va-b",
        source_blob="3" * 40,
        definitions=lineage_b_definitions(SYNTHETIC_DEFINITIONS),
    )


@pytest.mark.parametrize(
    ("old", "new", "check"),
    (
        (PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", re.I | re.S)\n', "admitted"),
        (PATTERN_LINE, PATTERN_NAME + " = len([1])\n", "envelope_assign"),
        (PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", flags=re.I)\n', "envelope_assign"),
        ("import re\n", "import re as r\n", "envelope_assign"),
    ),
)
def test_keyframe_scope_uses_the_shared_closed_regex_form(old: str, new: str, check: str) -> None:
    verdict = _module()._classify(variant(SOURCE_B, (old, new)).encode(), _manifest_b())
    assert verdict.check == check
    assert verdict.admitted is (check == "admitted")


def test_keyframe_production_lineages_are_closed_and_led_by_the_unchanged_manifest() -> None:
    module = _module()
    lineages = module.PRODUCTION_LINEAGES
    assert type(lineages) is tuple and lineages
    assert lineages[0] is module.PRODUCTION_MANIFEST
    assert lineages[0].fingerprint == PRODUCTION_MANIFEST_FINGERPRINT
    assert type(module.PRODUCTION_FINGERPRINTS) is frozenset
    assert module.PRODUCTION_FINGERPRINTS == {item.fingerprint for item in lineages}
    assert len(module.PRODUCTION_FINGERPRINTS) == len(lineages)


def test_keyframe_production_admission_is_membership_in_the_closed_fingerprint_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _module()
    a, b = _manifest(), _manifest_b()
    verdict_b = module._classify(SOURCE_B.encode(), b)
    assert verdict_b.admitted and not module.is_production_admission(verdict_b)
    monkeypatch.setattr(
        module, "PRODUCTION_FINGERPRINTS", frozenset({a.fingerprint, b.fingerprint})
    )
    assert module.is_production_admission(verdict_b)
    reason = module.KeyframeStructureReason
    verdict_type = module.NativeKeyframeStructureVerdict
    assert not module.is_production_admission(
        verdict_type(reason.CHANGED, "definition:FPS", b.fingerprint)
    )
    assert not module.is_production_admission(
        verdict_type(reason.ADMITTED, "admitted", b.fingerprint, classifier_schema="other")
    )
    assert not module.is_production_admission(
        verdict_type(reason.ADMITTED, "admitted", "sha256:" + "0" * 64)
    )
    assert not module.is_production_admission({"manifest_fingerprint": b.fingerprint})


def test_keyframe_production_entry_point_tries_the_production_lineages_in_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _module()
    a, b = _manifest(), _manifest_b()
    monkeypatch.setattr(module, "PRODUCTION_LINEAGES", (a, b))
    monkeypatch.setattr(
        module, "PRODUCTION_FINGERPRINTS", frozenset({a.fingerprint, b.fingerprint})
    )
    for source, manifest in ((SOURCE, a), (SOURCE_B, b)):
        verdict = module.classify_native_keyframe_source(source.encode())
        assert verdict.admitted and verdict.manifest_fingerprint == manifest.fingerprint
        assert module.is_production_admission(verdict)
    unrelated = module.classify_native_keyframe_source(b"x = 1\n")
    assert not unrelated.admitted and unrelated.manifest_fingerprint == b.fingerprint


def test_shared_guide_capability_requires_registration_and_all_inputs() -> None:
    guide = importlib.import_module("comfyui_h3_context.core.native_guide")
    required = frozenset({"positive", "vae", "latent", "image", "frame_idx"})
    assert guide.NativeGuideCapability(True, required).admitted
    assert not guide.NativeGuideCapability(False, required).admitted
    for field in required:
        assert not guide.NativeGuideCapability(True, required - {field}).admitted
