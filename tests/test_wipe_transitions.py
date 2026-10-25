"""Spatial wipe oracle boundaries, independent of a rendered observation."""

from __future__ import annotations

import math

import pytest

from comfyui_h3_context.core.composition_contract import WIPE_KINDS
from comfyui_h3_context.core.semantic_conformance_expect import (
    ExpectationError,
    LayerPlacement,
    _layer_alpha,
)


@pytest.mark.parametrize("kind", WIPE_KINDS)
@pytest.mark.parametrize("rotated", (False, True))
def test_spatial_alpha_has_exact_integer_edge_and_follows_rotation(
    kind: str, rotated: bool
) -> None:
    clip = {
        "start_frame": 10,
        "opacity_bp": 5000,
        "transition": {"kind": kind, "duration_frames": 6},
    }
    placement = LayerPlacement(0, 0, 64, 48, 64, 48, math.pi / 2 if rotated else 0, 100, 100)
    for elapsed in (0, 2, 5, 6):
        visible = 0
        for y in range(48):
            for x in range(64):
                lx, ly = x + 0.5 - 32, y + 0.5 - 24
                cx, cy = (100 - ly, 100 + lx) if rotated else (100 + lx, 100 + ly)
                alpha = _layer_alpha(clip, 10 + elapsed, placement, cx, cy)
                expected = {
                    "wipe_from_left_v1": x < 64 * elapsed // 6,
                    "wipe_from_right_v1": x >= 64 - 64 * elapsed // 6,
                    "wipe_from_top_v1": y < 48 * elapsed // 6,
                    "wipe_from_bottom_v1": y >= 48 - 48 * elapsed // 6,
                }[kind]
                assert alpha == (0.5 if expected else 0), (kind, elapsed, x, y)
                visible += alpha > 0
        expected_count = (
            (64 * elapsed // 6) * 48
            if "left" in kind or "right" in kind
            else (48 * elapsed // 6) * 64
        )
        assert visible == expected_count


def test_wipe_cannot_be_described_as_uniform_alpha() -> None:
    clip = {
        "start_frame": 0,
        "opacity_bp": 10000,
        "transition": {"kind": "wipe_from_left_v1", "duration_frames": 6},
    }
    with pytest.raises(ExpectationError, match="spatial placement"):
        _layer_alpha(clip, 2)
