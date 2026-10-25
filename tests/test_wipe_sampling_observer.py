"""Comparison samples respect declared bounds and independent pixel-safety guards."""

from __future__ import annotations

import pytest
from test_wipe_sampling_boundaries import _wire

from comfyui_h3_context.core.composition_contract import (
    decode_public_snapshot,
    public_snapshot_fingerprint,
)
from comfyui_h3_context.core.semantic_conformance import TOLERANCE_PROFILE
from comfyui_h3_context.core.semantic_conformance_cases import OVERLAY_CLIP
from comfyui_h3_context.core.semantic_conformance_media import SourceProfile


def test_wipe_samples_keep_the_full_patch_inside_the_canvas_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def flat_source(profile: SourceProfile, _frame: int, _x: int, _y: int) -> tuple[int, int, int]:
        return (210, 70, 50) if profile.asset_id == "vid-overlay" else (30, 80, 160)

    monkeypatch.setattr(expect, "source_colour", flat_source)
    wire = _wire("wipe_from_left_v1")
    clip = next(c for c in wire["clips"] if c["clip_id"] == OVERLAY_CLIP)
    # Move the layer near the real canvas boundary; preserve the admitted placement and guards.
    clip["transform"]["position_x_bp"] = -4656
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    decode_public_snapshot(wire)
    points = expect._wipe_sample_points(wire)
    assert points
    assert any(point.output_frame == 15 for point in points)
    radius = TOLERANCE_PROFILE.patch_size_px // 2
    for point in points:
        edge_distance = min(
            point.canvas_x - radius,
            point.canvas_y - radius,
            wire["output"]["width"] - 1 - point.canvas_x - radius,
            wire["output"]["height"] - 1 - point.canvas_y - radius,
        )
        assert edge_distance >= TOLERANCE_PROFILE.patch_min_edge_distance_px


def test_nonmapping_transition_cannot_be_a_measurable_ramp() -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    transition: object
    for transition in (None, [], "wipe_from_left_v1", 17, True):
        assert expect._declares_a_ramp({"transition": transition}) is False


def test_nonmapping_transition_cannot_offer_spatial_wipe_samples() -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    wire = _wire("wipe_from_left_v1")
    clip = next(c for c in wire["clips"] if c["clip_id"] == OVERLAY_CLIP)
    # The unit receives a declaration, not its producer's promise. Do not call the producer's
    # decoder again here: its refusal would prevent the sampling unit from seeing this value.
    transition: object
    for transition in (None, [], "wipe_from_left_v1", 17, True):
        clip["transition"] = transition
        assert expect._wipe_sample_points(wire) == ()


def test_a_small_measurable_layer_still_observes_both_sides_of_the_wipe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def flat_source(profile: SourceProfile, _frame: int, _x: int, _y: int) -> tuple[int, int, int]:
        return (210, 70, 50) if profile.asset_id == "vid-overlay" else (30, 80, 160)

    monkeypatch.setattr(expect, "source_colour", flat_source)
    wire = _wire("wipe_from_left_v1")
    clip = next(c for c in wire["clips"] if c["clip_id"] == OVERLAY_CLIP)
    clip["transform"]["scale_x_bp"] = 1875
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    decode_public_snapshot(wire)
    layers = expect._visual_layers(wire)
    points = expect._wipe_sample_points(wire)
    half_wipe_colours = {
        expect._composite_at(wire, layers, point.output_frame, point.canvas_x, point.canvas_y)
        for point in points
        if point.output_frame == 15
    }
    # Measurable hidden and revealed regions must both contribute an actual comparison.
    assert len(half_wipe_colours) == 2


def test_wipe_samples_never_name_a_frame_outside_the_declared_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def flat_source(profile: SourceProfile, _frame: int, _x: int, _y: int) -> tuple[int, int, int]:
        return (210, 70, 50) if profile.asset_id == "vid-overlay" else (30, 80, 160)

    monkeypatch.setattr(expect, "source_colour", flat_source)
    wire = _wire("wipe_from_left_v1")
    # A raw declaration can reach this unit without the producer's decoder. Keep the clip
    # covering the first excluded output frame so its separate bound cannot answer for this one.
    wire["output"]["duration_frames"] = 15
    points = expect._wipe_sample_points(wire)
    assert any(point.output_frame == 12 for point in points)
    assert all(0 <= point.output_frame < wire["output"]["duration_frames"] for point in points)


def _colours_at_frame(
    kind: str, transform: dict[str, int], frame: int, monkeypatch: pytest.MonkeyPatch
) -> set[tuple[int, int, int]]:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def flat_source(profile: SourceProfile, _frame: int, _x: int, _y: int) -> tuple[int, int, int]:
        return (210, 70, 50) if profile.asset_id == "vid-overlay" else (30, 80, 160)

    monkeypatch.setattr(expect, "source_colour", flat_source)
    wire = _wire(kind)
    clip = next(c for c in wire["clips"] if c["clip_id"] == OVERLAY_CLIP)
    clip["transform"].update(transform)
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    decode_public_snapshot(wire)
    layers = expect._visual_layers(wire)
    return {
        expect._composite_at(wire, layers, point.output_frame, point.canvas_x, point.canvas_y)
        for point in expect._wipe_sample_points(wire)
        if point.output_frame == frame
    }


def test_tall_layer_keeps_both_last_included_wipe_states(monkeypatch: pytest.MonkeyPatch) -> None:
    colours = _colours_at_frame(
        "wipe_from_top_v1", {"scale_x_bp": 7500, "scale_y_bp": 10000}, 17, monkeypatch
    )
    assert len(colours) == 2


def test_rotated_small_layer_keeps_both_measurable_half_wipe_states(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    colours = _colours_at_frame(
        "wipe_from_left_v1",
        {
            "scale_x_bp": 2500,
            "scale_y_bp": 2500,
            "rotation_mdeg": 45000,
            "position_x_bp": 16,
            "position_y_bp": 28,
        },
        15,
        monkeypatch,
    )
    assert len(colours) == 2


def test_wipe_samples_keep_the_full_patch_inside_the_bottom_canvas_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def flat_source(profile: SourceProfile, _frame: int, _x: int, _y: int) -> tuple[int, int, int]:
        return (210, 70, 50) if profile.asset_id == "vid-overlay" else (30, 80, 160)

    monkeypatch.setattr(expect, "source_colour", flat_source)
    wire = _wire("wipe_from_top_v1")
    clip = next(c for c in wire["clips"] if c["clip_id"] == OVERLAY_CLIP)
    # Move the layer near the real canvas boundary; preserve the admitted placement and guards.
    clip["transform"]["position_y_bp"] = 4278
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    decode_public_snapshot(wire)
    points = expect._wipe_sample_points(wire)
    assert points
    assert any(point.output_frame == 15 for point in points)
    radius = TOLERANCE_PROFILE.patch_size_px // 2
    for point in points:
        edge_distance = min(
            point.canvas_x - radius,
            point.canvas_y - radius,
            wire["output"]["width"] - 1 - point.canvas_x - radius,
            wire["output"]["height"] - 1 - point.canvas_y - radius,
        )
        assert edge_distance >= TOLERANCE_PROFILE.patch_min_edge_distance_px


def test_wipe_samples_keep_the_full_patch_inside_the_left_canvas_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def flat_source(profile: SourceProfile, _frame: int, _x: int, _y: int) -> tuple[int, int, int]:
        return (210, 70, 50) if profile.asset_id == "vid-overlay" else (30, 80, 160)

    monkeypatch.setattr(expect, "source_colour", flat_source)
    wire = _wire("wipe_from_left_v1")
    clip = next(c for c in wire["clips"] if c["clip_id"] == OVERLAY_CLIP)
    # Move the layer near the real canvas boundary; preserve the admitted placement and guards.
    clip["transform"]["position_x_bp"] = -4625
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    decode_public_snapshot(wire)
    points = expect._wipe_sample_points(wire)
    assert points
    assert any(point.output_frame == 15 for point in points)
    radius = TOLERANCE_PROFILE.patch_size_px // 2
    for point in points:
        edge_distance = min(
            point.canvas_x - radius,
            point.canvas_y - radius,
            wire["output"]["width"] - 1 - point.canvas_x - radius,
            wire["output"]["height"] - 1 - point.canvas_y - radius,
        )
        assert edge_distance >= TOLERANCE_PROFILE.patch_min_edge_distance_px


def test_wipe_samples_only_state_colours_from_flat_comparison_patches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def striped_source(
        profile: SourceProfile, _frame: int, x: int, _y: int
    ) -> tuple[int, int, int]:
        if profile.asset_id == "vid-overlay":
            value = 255 if (int(x) // 4) % 2 else 0
            return (value, value, value)
        return (80, 80, 80)

    # Achromatic bands have no chroma transitions. Preserve both independent safety guards.
    monkeypatch.setattr(expect, "source_colour", striped_source)
    wire = _wire("wipe_from_left_v1")
    layers = expect._visual_layers(wire)
    points = expect._wipe_sample_points(wire)
    assert points
    assert any(point.output_frame == 15 for point in points)
    radius = TOLERANCE_PROFILE.patch_size_px // 2
    for point in points:
        center = expect._composite_at(
            wire, layers, point.output_frame, point.canvas_x, point.canvas_y
        )
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                assert (
                    expect._composite_at(
                        wire, layers, point.output_frame, point.canvas_x + dx, point.canvas_y + dy
                    )
                    == center
                )


def test_wipe_samples_avoid_a_close_chroma_edge_pair_beside_a_flat_patch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    stripe_start, stripe_stop = 45, 49

    def striped_source(
        profile: SourceProfile, _frame: int, x: int, _y: int
    ) -> tuple[int, int, int]:
        if profile.asset_id == "vid-overlay":
            return (255, 0, 0) if stripe_start <= x < stripe_stop else (0, 255, 0)
        return (0, 0, 255)

    monkeypatch.setattr(expect, "source_colour", striped_source)
    wire = _wire("wipe_from_left_v1")
    layers = expect._visual_layers(wire)
    overlay = next(layer for layer in layers if layer.clip["clip_id"] == OVERLAY_CLIP)
    left = overlay.placement.to_canvas(stripe_start, 48)
    right = overlay.placement.to_canvas(stripe_stop, 48)
    assert left is not None and right is not None
    # The declared four-pixel stripe has two chroma edges within one eight-pixel coding block.
    assert right[0] - left[0] == 4
    stripe_pixel = expect._composite_at(wire, layers, 15, left[0] + 1, left[1])
    for x in (left[0] - 1, right[0] + 1):
        assert expect._composite_at(wire, layers, 15, x, left[1]) != stripe_pixel
    points = [point for point in expect._wipe_sample_points(wire) if point.output_frame == 15]
    assert points
    # A flat five-pixel patch is still unsafe within one coding block of this close pair.
    near = TOLERANCE_PROFILE.patch_size_px // 2 + 8
    for point in points:
        # A changed cross position can lie above/below the layer. Establish the stripe's
        # actual two edges on this row before applying its horizontal exclusion band.
        stripe_here = expect._composite_at(wire, layers, 15, left[0] + 1, point.canvas_y)
        neighbours = [
            expect._composite_at(wire, layers, 15, x, point.canvas_y)
            for x in (left[0] - 1, right[0] + 1)
        ]
        if all(colour != stripe_here for colour in neighbours):
            assert not left[0] - near <= point.canvas_x <= right[0] + near


def test_wipe_samples_keep_the_full_patch_inside_the_right_canvas_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import comfyui_h3_context.core.semantic_conformance_expect as expect

    def flat_source(profile: SourceProfile, _frame: int, _x: int, _y: int) -> tuple[int, int, int]:
        return (210, 70, 50) if profile.asset_id == "vid-overlay" else (30, 80, 160)

    monkeypatch.setattr(expect, "source_colour", flat_source)
    wire = _wire("wipe_from_left_v1")
    clip = next(c for c in wire["clips"] if c["clip_id"] == OVERLAY_CLIP)
    # Move the layer near the real canvas boundary; preserve the admitted placement and guards.
    clip["transform"]["position_x_bp"] = 4594
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    decode_public_snapshot(wire)
    points = expect._wipe_sample_points(wire)
    assert points
    assert any(point.output_frame == 15 for point in points)
    radius = TOLERANCE_PROFILE.patch_size_px // 2
    for point in points:
        edge_distance = min(
            point.canvas_x - radius,
            point.canvas_y - radius,
            wire["output"]["width"] - 1 - point.canvas_x - radius,
            wire["output"]["height"] - 1 - point.canvas_y - radius,
        )
        assert edge_distance >= TOLERANCE_PROFILE.patch_min_edge_distance_px
