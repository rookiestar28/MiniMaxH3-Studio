"""Schedule boundaries and independent descriptor guards for directional wipes."""

from __future__ import annotations

import importlib
from dataclasses import replace
from typing import Any

import pytest
from test_m25_authoring_render_jobs import _plan, long_plan

from comfyui_h3_context.core.canonical import canonical_fingerprint
from comfyui_h3_context.core.composition_contract import Transition


class DerivedTransition(Transition):
    pass


def _graphs() -> Any:
    return importlib.import_module("comfyui_h3_context.adapters.authoring_render_graph")


def _with_wipe(plan: Any, clip_id: str, descriptor: Transition, active_frames: int) -> Any:
    start = min(
        frame.frame
        for chunk in plan.resolved_operations
        for frame in chunk.frames
        if any(layer.clip_id == clip_id for layer in frame.layers)
    )
    chunks = []
    for chunk in plan.resolved_operations:
        frames = []
        for frame in chunk.frames:
            elapsed = frame.frame - start
            layers = []
            for layer in frame.layers:
                if layer.clip_id == clip_id:
                    operations = tuple(
                        value
                        for value in layer.operation_ids
                        if value not in {"CrossDissolveV1", "WipeV1"}
                    )
                    active = 0 <= elapsed < active_frames
                    layer = replace(
                        layer,
                        wipe=descriptor,
                        transition_elapsed_frames=elapsed if active else None,
                        operation_ids=operations + (("WipeV1",) if active else ()),
                    )
                layers.append(layer)
            frames.append(replace(frame, layers=tuple(layers)))
        changed = replace(chunk, frames=tuple(frames))
        chunks.append(
            replace(
                changed, chunk_fingerprint=canonical_fingerprint(changed.fingerprint_material())
            )
        )
    return replace(plan, resolved_operations=tuple(chunks))


@pytest.mark.parametrize("duration", (1, 12))
def test_schedule_accepts_one_frame_and_whole_clip_wipe(duration: int) -> None:
    plan = _with_wipe(
        _plan(), "clip-video-overlay", Transition("wipe_from_left_v1", duration), duration
    )
    run = next(
        row
        for row in _graphs().compile_render_schedule(plan).layers
        if row.layer.clip_id == "clip-video-overlay"
    )
    assert (run.start, run.end) == (12, 24)
    assert run.layer.wipe == Transition("wipe_from_left_v1", duration)
    assert len(run.source_frames) == len(run.source_pts) == 12


@pytest.mark.parametrize("fault", ("descriptor_class", "boolean_duration", "zero", "past_cap"))
def test_schedule_refuses_independently_invalid_wipe_descriptor(fault: str) -> None:
    plan = long_plan(continuous_image=True) if fault == "past_cap" else _plan()
    clip_id = "clip-video-overlay"
    if fault == "past_cap":
        clip_id = next(
            layer.clip_id
            for chunk in plan.resolved_operations
            for frame in chunk.frames
            for layer in frame.layers
            if layer.asset_id == "img-overlay"
        )
    descriptor: Transition
    if fault == "descriptor_class":
        descriptor, active = DerivedTransition("wipe_from_left_v1", 4), 4
    elif fault == "boolean_duration":
        descriptor, active = Transition("wipe_from_left_v1", True), 1
    elif fault == "zero":
        descriptor, active = Transition("wipe_from_left_v1", 0), 0
    else:
        descriptor, active = Transition("wipe_from_left_v1", 301), 301
    changed = _with_wipe(plan, clip_id, descriptor, active)
    with pytest.raises(_graphs().RenderGraphError, match="plan_mismatch"):
        _graphs().compile_render_schedule(changed)


def test_schedule_refuses_changed_nontransition_operations_inside_a_clip() -> None:
    plan = _with_wipe(_plan(), "clip-video-overlay", Transition("wipe_from_left_v1", 4), 4)
    chunks = []
    changed_count = 0
    for chunk in plan.resolved_operations:
        frames = []
        for frame in chunk.frames:
            layers = []
            for layer in frame.layers:
                if frame.frame == 13 and layer.clip_id == "clip-video-overlay":
                    layer = replace(
                        layer,
                        operation_ids=tuple(
                            value for value in layer.operation_ids if value != "OpacityV1"
                        ),
                    )
                    changed_count += 1
                layers.append(layer)
            frames.append(replace(frame, layers=tuple(layers)))
        changed = replace(chunk, frames=tuple(frames))
        chunks.append(
            replace(
                changed, chunk_fingerprint=canonical_fingerprint(changed.fingerprint_material())
            )
        )
    assert changed_count == 1
    with pytest.raises(_graphs().RenderGraphError, match="plan_mismatch"):
        _graphs().compile_render_schedule(replace(plan, resolved_operations=tuple(chunks)))


def test_schedule_preserves_the_existing_cross_dissolve_duration() -> None:
    schedule = _graphs().compile_render_schedule(_plan())
    run = next(row for row in schedule.layers if row.layer.clip_id == "clip-video-overlay")
    assert run.layer.wipe is None
    assert run.dissolve_frames == 4
