"""Wipe comparison patches cover both states within admitted space and time."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from comfyui_h3_context.core.composition_contract import (
    WIPE_KINDS,
    decode_public_snapshot,
    public_snapshot_fingerprint,
)
from comfyui_h3_context.core.semantic_conformance import TOLERANCE_PROFILE
from comfyui_h3_context.core.semantic_conformance_cases import OVERLAY_CLIP
from comfyui_h3_context.core.semantic_conformance_expect import (
    _composite_at,
    _visual_layers,
    _wipe_sample_points,
)
from comfyui_h3_context.core.semantic_conformance_media import SourceProfile


def _wire(kind: str, *, duration: int = 6, start: int = 12, angle: int = 0) -> dict[str, Any]:
    # __file__ can be an ignored draft; resolve fixtures from the actually imported package.
    import comfyui_h3_context

    root = Path(comfyui_h3_context.__file__).resolve().parents[1]
    wire: dict[str, Any] = json.loads(
        (root / "tests/fixtures/m25_20_semantic_corpus_base_v1.json").read_text(encoding="utf-8")
    )["snapshot"]
    for clip in wire["clips"]:
        if clip["clip_id"] in {"clip-image", "clip-title"}:
            clip["enabled"] = False
        if clip["clip_id"] == OVERLAY_CLIP:
            clip["start_frame"] = start
            clip["transition"] = {"kind": kind, "duration_frames": duration}
            clip["transform"].update(
                scale_x_bp=10000,
                scale_y_bp=7500,
                position_x_bp=0,
                position_y_bp=0,
                rotation_mdeg=angle,
            )
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    decode_public_snapshot(wire)
    return wire


@pytest.mark.parametrize("kind", WIPE_KINDS)
def test_wipe_samples_do_not_include_the_exclusive_clip_end(kind: str) -> None:
    wire = _wire(kind, duration=12)
    points = _wipe_sample_points(wire)
    assert points
    assert {12, 18}.issubset({p.output_frame for p in points})
    assert all(12 <= p.output_frame < 24 for p in points)


@pytest.mark.parametrize("kind", WIPE_KINDS)
def test_wipe_at_output_start_still_samples_its_empty_first_frame(kind: str) -> None:
    points = _wipe_sample_points(_wire(kind, start=0))
    assert any(p.output_frame == 0 for p in points)


@pytest.mark.parametrize("angle", (0, 30000))
@pytest.mark.parametrize("kind", WIPE_KINDS)
def test_wipe_patches_cover_both_states_and_avoid_edges(
    kind: str, angle: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Flat fields isolate geometric coverage from fixture marks that correctly reject patches.
    # Keep actual composition, placement, alpha and safety guards; vary only declared source colour.
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def flat_source(profile: SourceProfile, _frame: int, _x: int, _y: int) -> tuple[int, int, int]:
        return (210, 70, 50) if profile.asset_id == "vid-overlay" else (30, 80, 160)

    monkeypatch.setattr(expect, "source_colour", flat_source)
    wire = _wire(kind, angle=angle)
    layers = _visual_layers(wire)
    layer = next(layer for layer in layers if layer.clip["clip_id"] == OVERLAY_CLIP)
    placement = layer.placement
    assert placement.scaled_width != placement.scaled_height
    points = _wipe_sample_points(wire)
    states: dict[int, set[bool]] = {}
    radius = TOLERANCE_PROFILE.patch_size_px // 2
    safe = TOLERANCE_PROFILE.patch_min_edge_distance_px + radius
    horizontal = kind in {"wipe_from_left_v1", "wipe_from_right_v1"}
    dimension = placement.scaled_width if horizontal else placement.scaled_height
    cosine, sine = math.cos(placement.angle), math.sin(placement.angle)
    for point in points:
        assert 12 <= point.output_frame < 24
        assert safe <= point.canvas_x < wire["output"]["width"] - safe
        assert safe <= point.canvas_y < wire["output"]["height"] - safe
        dx, dy = point.canvas_x - placement.center_x, point.canvas_y - placement.center_y
        local_x = dx * cosine + dy * sine + placement.scaled_width / 2
        local_y = -dx * sine + dy * cosine + placement.scaled_height / 2
        assert 0 <= local_x < placement.scaled_width
        assert 0 <= local_y < placement.scaled_height
        elapsed = point.output_frame - 12
        extent = dimension * elapsed // 6
        axis = local_x if horizontal else local_y
        reverse = kind in {"wipe_from_right_v1", "wipe_from_bottom_v1"}
        visible = axis >= dimension - extent if reverse else axis < extent
        states.setdefault(elapsed, set()).add(visible)
        if 0 < elapsed < 6:
            edge = dimension - extent if reverse else extent
            assert abs(axis - edge) >= safe
        # Test the observable patch rather than the sampler's private choice of cross positions.
        center = _composite_at(wire, layers, point.output_frame, point.canvas_x, point.canvas_y)
        for ox in range(-radius, radius + 1):
            for oy in range(-radius, radius + 1):
                assert (
                    _composite_at(
                        wire, layers, point.output_frame, point.canvas_x + ox, point.canvas_y + oy
                    )
                    == center
                )
    assert states[0] == {False}
    assert states[3] == {False, True}
    assert states[5] == {False, True}
    assert states[6] == {True}


@pytest.mark.parametrize("angle", (0, 30000))
def test_wipe_empty_and_full_sampling_geometry_is_direction_independent(angle: int) -> None:
    endpoints = []
    for kind in WIPE_KINDS:
        points = _wipe_sample_points(_wire(kind, angle=angle))
        endpoints.append(
            {(p.output_frame, p.canvas_x, p.canvas_y) for p in points if p.output_frame in {12, 18}}
        )
    assert endpoints[0]
    assert all(points == endpoints[0] for points in endpoints)
