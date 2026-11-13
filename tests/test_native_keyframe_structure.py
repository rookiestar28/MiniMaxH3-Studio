"""Unmasked, parse-only keyframe surface checks using authored synthetic source."""

import importlib
from types import ModuleType
from typing import cast

import pytest
from native_t2va_fixtures import SYNTHETIC_DEFINITIONS, SYNTHETIC_SOURCE, synthetic_manifest

from comfyui_h3_context.core import native_t2va_structure as t2va
from comfyui_h3_context.core.native_keyframe_structure import NativeKeyframeBaselineManifest

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


def test_shared_guide_capability_requires_registration_and_all_inputs() -> None:
    guide = importlib.import_module("comfyui_h3_context.core.native_guide")
    required = frozenset({"positive", "vae", "latent", "image", "frame_idx"})
    assert guide.NativeGuideCapability(True, required).admitted
    assert not guide.NativeGuideCapability(False, required).admitted
    for field in required:
        assert not guide.NativeGuideCapability(True, required - {field}).admitted
