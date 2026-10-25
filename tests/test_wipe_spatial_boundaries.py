"""Spatial alpha refuses unknown kinds and uses half-open layer-local wipe edges."""

import pytest

from comfyui_h3_context.core.semantic_conformance_expect import (
    ExpectationError,
    LayerPlacement,
    _layer_alpha,
)


def test_spatial_alpha_refuses_unknown_direction_with_valid_geometry() -> None:
    clip = {
        "start_frame": 10,
        "opacity_bp": 5000,
        "transition": {"kind": "unknown_spatial_transition", "duration_frames": 6},
    }
    placement = LayerPlacement(0, 0, 64, 48, 64, 48, 0, 100, 100)
    with pytest.raises(ExpectationError):
        _layer_alpha(clip, 12, placement, 100, 100)


@pytest.mark.parametrize(
    "kind,edge,before,after,edge_alpha,before_alpha,after_alpha",
    (
        ("wipe_from_left_v1", (89, 100), (88.75, 100), (89.25, 100), 0, 0.5, 0),
        ("wipe_from_right_v1", (111, 100), (110.75, 100), (111.25, 100), 0.5, 0, 0.5),
        ("wipe_from_top_v1", (100, 92), (100, 91.75), (100, 92.25), 0, 0.5, 0),
        ("wipe_from_bottom_v1", (100, 108), (100, 107.75), (100, 108.25), 0.5, 0, 0.5),
    ),
)
def test_spatial_alpha_uses_half_open_integer_boundary(
    kind: str,
    edge: tuple[float, float],
    before: tuple[float, float],
    after: tuple[float, float],
    edge_alpha: float,
    before_alpha: float,
    after_alpha: float,
) -> None:
    # At elapsed 2/6 the 64x48 layer exposes exactly 21 columns or 16 rows.
    clip = {
        "start_frame": 10,
        "opacity_bp": 5000,
        "transition": {"kind": kind, "duration_frames": 6},
    }
    placement = LayerPlacement(0, 0, 64, 48, 64, 48, 0, 100, 100)
    assert _layer_alpha(clip, 12, placement, *edge) == edge_alpha
    assert _layer_alpha(clip, 12, placement, *before) == before_alpha
    assert _layer_alpha(clip, 12, placement, *after) == after_alpha
