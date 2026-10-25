"""Host admission uses the packaged face without changing the qualified renderer."""

from __future__ import annotations

import copy
import json
from typing import Any, cast

import pytest
from test_authoring_workspace import (
    _Harness,
    history_snapshot,
    rejection_code,
    timeline_transaction,
)

from comfyui_h3_context.core.composition_contract import (
    decode_public_snapshot,
    public_snapshot_fingerprint,
)
from comfyui_h3_context.core.nle_authoring_contract import (
    NLE_AUTHORING_PROFILE_ID,
    NLE_AUTHORING_SCHEMA,
    NLE_OPERATION_PROFILE_ID,
    TIMELINE_TRANSACTION_SCHEMA_V2,
    create_nle_authoring_state,
)
from comfyui_h3_context.core.timeline_history import apply_timeline_transaction
from comfyui_h3_context.core.timeline_history_v2 import (
    TimelineHistoryStateV2,
    apply_timeline_transaction_v2,
)

FONT = "h3.font.noto_sans.v1"


def workspace(version: int, content: str = "Supported title") -> tuple[Any, str]:
    harness = _Harness()
    handle, _ = harness.create()
    wire = cast(dict[str, Any], history_snapshot(handle).to_wire())
    font = next(asset for asset in wire["assets"] if asset["kind"] == "font")
    font["asset_id"] = FONT
    next(clip for clip in wire["clips"] if clip["text"])["text"].update(
        font_asset_id=FONT, content=content, style="normal", weight=400
    )
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    snapshot = decode_public_snapshot(wire)
    harness.registry.bind_timeline_history_snapshot(snapshot)
    if version == 2:
        # This accepted-state fixture bypasses media acquisition, never transaction dispatch.
        entry = harness.registry._entries[handle]
        entry.timeline_history_v2 = TimelineHistoryStateV2.initialize(
            create_nle_authoring_state(
                project_id=snapshot.project_id,
                workspace_handle=handle,
                workspace_revision=snapshot.workspace_revision,
                timeline_revision=snapshot.timeline_revision,
                edit_capacity_frames=3600,
                assets=snapshot.assets,
                tracks=snapshot.tracks,
                clips=snapshot.clips,
                audio_extension=snapshot.audio_extension,
                blockers=snapshot.blockers,
            )
        )
    return harness, handle


def read(harness: Any, handle: str) -> dict[str, Any]:
    result = harness.registry.dispatch(
        harness.act("read_timeline_history", workspace_handle=handle)
    )
    assert result.status == 200
    return cast(dict[str, Any], result.body)


def action(harness: Any, handle: str, commands: list[dict[str, Any]]) -> dict[str, Any]:
    entry = harness.registry._entries[handle]
    history = harness.registry._history(entry)
    request = harness.act("apply_timeline_transaction")
    if isinstance(history, TimelineHistoryStateV2):
        state = history.authoring
        transaction = dict(
            schema=TIMELINE_TRANSACTION_SCHEMA_V2,
            authoring_schema=NLE_AUTHORING_SCHEMA,
            profile_id=NLE_AUTHORING_PROFILE_ID,
            operation_profile_id=NLE_OPERATION_PROFILE_ID,
            request_id=request["request_id"],
            transaction_id="tx-" + request["request_id"],
            workspace_handle=handle,
            expected_workspace_revision=state.workspace_revision,
            expected_timeline_revision=state.timeline_revision,
            expected_timeline_fingerprint=state.timeline_fingerprint,
            expected_authoring_fingerprint=state.authoring_fingerprint,
            commands=commands,
        )
    else:
        transaction = timeline_transaction(
            history.snapshot, request_id=request["request_id"], commands=commands
        )
    request["payload"] = transaction
    return cast(dict[str, Any], request)


def edit(harness: Any, handle: str, kind: str, content: str) -> dict[str, Any]:
    projection = read(harness, handle)
    state = cast(dict[str, Any], projection.get("snapshot", projection.get("authoring")))
    title = copy.deepcopy(next(clip for clip in state["clips"] if clip["text"]))
    if kind == "insert_title_clip":
        title.update(clip_id="title-new", start_frame=30, duration_frames=10)
        title["text"]["content"] = content
        payload = {"clip": title}
    else:
        payload = {"clip_id": title["clip_id"], "content": content}
    return {"kind": kind, "payload": payload}


@pytest.mark.parametrize("version", [1, 2])
@pytest.mark.parametrize("kind", ["insert_title_clip", "set_text_content"])
@pytest.mark.parametrize("content", ["中文", "한국어", "😀"], ids=["cjk", "hangul", "emoji"])
def test_unsupported_title_is_refused_atomically(version: int, kind: str, content: str) -> None:
    harness, handle = workspace(version)
    before = read(harness, handle)
    request = action(harness, handle, [edit(harness, handle, kind, content)])
    result = harness.registry.dispatch(request)
    assert result.status == 409
    assert rejection_code(result.body) == "font_glyph_unsupported"
    assert read(harness, handle) == before


@pytest.mark.parametrize("version", [1, 2])
@pytest.mark.parametrize("content", ["\u10fb", "\u20c0", "\u2183"])
def test_style_change_losing_packaged_coverage_is_refused(version: int, content: str) -> None:
    harness, handle = workspace(version, content)
    before = read(harness, handle)
    state = cast(dict[str, Any], before.get("snapshot", before.get("authoring")))
    title = next(clip for clip in state["clips"] if clip["text"])
    style = {key: value for key, value in title["text"].items() if key != "content"}
    style.update(style="italic", weight=700)
    result = harness.registry.dispatch(
        action(
            harness,
            handle,
            [{"kind": "set_text_style", "payload": {"clip_id": title["clip_id"], "style": style}}],
        )
    )
    assert result.status == 409
    assert rejection_code(result.body) == "font_glyph_unsupported"
    assert read(harness, handle) == before


@pytest.mark.parametrize("version", [1, 2])
@pytest.mark.parametrize("kind", ["insert_title_clip", "set_text_content"])
@pytest.mark.parametrize(
    "content", ["Café — Ελληνικά, Кириллица!\nNext", "A" * 2048, "A\n" * 31 + "A"]
)
def test_supported_title_receipt_matches_existing_core_bytes(
    version: int, kind: str, content: str
) -> None:
    harness, handle = workspace(version)
    request = action(harness, handle, [edit(harness, handle, kind, content)])
    history = harness.registry._history(harness.registry._entries[handle])
    apply = apply_timeline_transaction_v2 if version == 2 else apply_timeline_transaction
    _, expected = apply(history, request["payload"])
    result = harness.registry.dispatch(request)
    assert result.status == 200
    assert result.body == expected.to_wire()
    assert json.dumps(result.body, ensure_ascii=False).encode("utf-8") == json.dumps(
        expected.to_wire(), ensure_ascii=False
    ).encode("utf-8")
    assert harness.registry.dispatch(request).body == result.body


@pytest.mark.parametrize("version", [1, 2])
def test_existing_unsupported_title_opens_and_allows_unrelated_edits(version: int) -> None:
    harness, handle = workspace(version, "中文")
    before = read(harness, handle)
    for command in [
        {
            "kind": "move_clip",
            "payload": {
                "clip_id": "clip-title",
                "delta_frames": 1,
                "target_track_id": "track-text",
            },
        },
        {
            "kind": "trim_clip",
            "payload": {"clip_id": "clip-title", "edge": "end", "delta_frames": -1},
        },
        {"kind": "select_clips", "payload": {"clip_ids": ["clip-main"]}},
        {
            "kind": "set_opacity_blend",
            "payload": {"clip_id": "clip-image", "opacity_bp": 7000, "blend": "screen"},
        },
    ]:
        result = harness.registry.dispatch(action(harness, handle, [command]))
        assert result.status == 200
    assert read(harness, handle) != before


@pytest.mark.parametrize("version", [1, 2])
def test_existing_unsupported_noop_and_historical_navigation_stay_usable(version: int) -> None:
    harness, handle = workspace(version, "中文")
    noop = harness.registry.dispatch(
        action(harness, handle, [edit(harness, handle, "set_text_content", "中文")])
    )
    assert noop.status == 200
    result = harness.registry.dispatch(
        action(harness, handle, [edit(harness, handle, "set_text_content", "Supported")])
    )
    assert result.status == 200
    cursor = result.body["history_cursor"]
    undone = harness.registry.dispatch(
        action(harness, handle, [{"kind": "undo", "payload": {"history_cursor": cursor}}])
    )
    assert undone.status == 200
    projection = read(harness, handle)
    state = cast(dict[str, Any], projection.get("snapshot", projection.get("authoring")))
    assert next(clip for clip in state["clips"] if clip["text"])["text"]["content"] == "中文"
    redone = harness.registry.dispatch(
        action(
            harness,
            handle,
            [{"kind": "redo", "payload": {"history_cursor": projection["redo_cursor"]}}],
        )
    )
    assert redone.status == 200


@pytest.mark.parametrize("version", [1, 2])
def test_packaged_manifest_failure_stays_closed_without_mislabeling_glyphs(
    version: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    from comfyui_h3_context.adapters import comfyui_authoring_workspace as host
    from comfyui_h3_context.adapters.authoring_fonts import AuthoringFontError

    harness, handle = workspace(version)
    before = read(harness, handle)
    request = action(harness, handle, [edit(harness, handle, "set_text_content", "Next")])

    def corrupted() -> None:
        raise AuthoringFontError("font_manifest_invalid", "synthetic invalid package")

    monkeypatch.setattr(host, "load_packaged_font_manifest", corrupted)
    result = harness.registry.dispatch(request)
    assert result.status == 409
    assert rejection_code(result.body) == "font_manifest_invalid"
    assert read(harness, handle) == before


@pytest.mark.parametrize("version", [1, 2])
def test_unsupported_batch_rolls_back_other_edits_and_rejection_keeps_cas_precedence(
    version: int,
) -> None:
    harness, handle = workspace(version)
    before = read(harness, handle)
    commands = [
        {"kind": "select_clips", "payload": {"clip_ids": ["clip-main"]}},
        edit(harness, handle, "set_text_content", "😀"),
    ]
    request = action(harness, handle, commands)
    result = harness.registry.dispatch(request)
    assert result.status == 409
    assert rejection_code(result.body) == "font_glyph_unsupported"
    assert read(harness, handle) == before
    request["request_id"] += "-stale"
    request["payload"]["request_id"] = request["request_id"]
    request["payload"]["expected_workspace_revision"] += 1
    result = harness.registry.dispatch(request)
    assert result.status == 409
    assert rejection_code(result.body) != "font_glyph_unsupported"
