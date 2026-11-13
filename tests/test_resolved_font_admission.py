"""Real packaged fallback must survive source binding and native planning admission."""

from __future__ import annotations

import asyncio
import copy
import json
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import pytest
from deployment_request_doubles import LOOPBACK_HOST, LOOPBACK_ORIGIN, ListenerTransport
from test_m25_render_planner import _snapshot_wire

from comfyui_h3_context.adapters import authoring_render_executor as executor
from comfyui_h3_context.adapters import authoring_render_source as source
from comfyui_h3_context.adapters.authoring_fonts import (
    load_packaged_font_manifest,
    require_text_coverage,
    resolve_packaged_font,
)
from comfyui_h3_context.adapters.authoring_output_service import AuthoringOutputRegistry
from comfyui_h3_context.adapters.authoring_source_binding import AuthoringSourceBindingError
from comfyui_h3_context.adapters.comfyui_authoring_output import AuthoringOutputRoutes
from comfyui_h3_context.core.authoring_output_protocol import (
    OUTPUT_CREATE_SCHEMA,
    OUTPUT_ERROR_SCHEMA,
    AuthoringOutputCreate,
)
from comfyui_h3_context.core.canonical import canonical_fingerprint
from comfyui_h3_context.core.composition_contract import (
    OUTPUT_PROFILE_ID,
    PublicCompositionSnapshot,
    decode_public_snapshot,
    public_snapshot_fingerprint,
)
from comfyui_h3_context.core.render_planner import (
    FONT_FACTS_SCHEMA,
    FontTitleBindingFact,
    PackagedFontFacts,
    packaged_font_facts_fingerprint,
)

DEFAULT = "h3.font.noto_sans.v1"
JP = "h3.font.noto_sans_jp.v1"
KR = "h3.font.noto_sans_kr.v1"
TC = "h3.font.noto_sans_tc.v1"


def title_snapshot(
    content: str, requested: str = DEFAULT, weight: int = 400
) -> PublicCompositionSnapshot:
    wire = _snapshot_wire()
    wire["workspace_handle"] = "authoring-" + "a" * 32
    font = next(asset for asset in wire["assets"] if asset["kind"] == "font")
    wire["assets"] = [
        dict(copy.deepcopy(font), asset_id=asset_id)
        for asset_id in load_packaged_font_manifest().fallback_order
    ]
    wire["clips"] = [clip for clip in wire["clips"] if clip["text"] is not None]
    wire["clips"][0]["text"].update(
        content=content, font_asset_id=requested, weight=weight, style="normal"
    )
    wire["public_fingerprint"] = public_snapshot_fingerprint(wire)
    return decode_public_snapshot(wire)


def font_facts(snapshot: PublicCompositionSnapshot) -> PackagedFontFacts:
    fonts = load_packaged_font_manifest()
    clip = snapshot.clips[0]
    assert clip.text is not None
    text = clip.text
    face = require_text_coverage(fonts, text.font_asset_id, text.weight, text.style, text.content)
    binding = FontTitleBindingFact(
        clip_id=clip.clip_id,
        font_asset_id=face.font_asset_id,
        artifact_id=face.artifact_id,
        weight=face.weight,
        style=face.style,
        text_fingerprint=canonical_fingerprint({"content": text.content}),
        file_fingerprint=face.file_fingerprint,
        cmap_fingerprint=face.cmap_fingerprint,
        build_version=face.build_version,
    )
    facts = PackagedFontFacts(
        schema_version=FONT_FACTS_SCHEMA,
        manifest_schema_version=fonts.schema_version,
        profile_id=fonts.profile_id,
        fallback_order=fonts.fallback_order,
        license_spdx_id=fonts.license_spdx_id,
        manifest_fingerprint=fonts.manifest_fingerprint,
        package_fingerprint=fonts.package_fingerprint,
        license_file_fingerprint=fonts.license_file_fingerprint,
        title_bindings=(binding,),
        facts_fingerprint="sha256:" + "0" * 64,
    )
    return replace(facts, facts_fingerprint=packaged_font_facts_fingerprint(facts))


def bind(snapshot: PublicCompositionSnapshot) -> source.BoundAuthoringRenderPlan:
    history = source.PreparedAuthoringHistory(snapshot, 0, (), load_packaged_font_manifest())
    return source.prepare_bound_render_plan(history, snapshot, lambda: True)


@pytest.mark.parametrize(
    ("content", "requested", "weight", "resolved"),
    [
        ("かなカナ", DEFAULT, 400, JP),
        ("かなカナ", DEFAULT, 700, JP),
        ("한국어", DEFAULT, 400, KR),
        ("한국어", DEFAULT, 700, KR),
        ("かなカナ", JP, 400, JP),
        ("Latin Ελληνικά Кириллица", DEFAULT, 400, DEFAULT),
    ],
)
def test_real_fallback_matrix(content: str, requested: str, weight: int, resolved: str) -> None:
    snapshot = title_snapshot(content, requested, weight)
    facts = font_facts(snapshot)
    assert facts.title_bindings[0].font_asset_id == resolved
    assert (requested != resolved) == (requested == DEFAULT and resolved in {JP, KR})
    bound = bind(snapshot)
    assert bound.plan.font_facts_fingerprint == facts.facts_fingerprint


@pytest.mark.parametrize(
    "field",
    [
        "wrong_face",
        "artifact_id",
        "weight",
        "style",
        "file_fingerprint",
        "cmap_fingerprint",
        "build_version",
        "missing_clip",
    ],
)
def test_resolved_guard_refuses_wrong_identity(field: str) -> None:
    guard = getattr(source, "_require_resolved_font_bindings", None)
    assert callable(guard), "resolved font guard absent"
    snapshot = title_snapshot("かなカナ")
    facts = font_facts(snapshot)
    binding = facts.title_bindings[0]
    if field == "wrong_face":
        wrong = resolve_packaged_font(load_packaged_font_manifest(), TC, 400, "normal")
        binding = replace(
            binding,
            **{
                name: getattr(wrong, name)
                for name in (
                    "font_asset_id",
                    "artifact_id",
                    "weight",
                    "style",
                    "file_fingerprint",
                    "cmap_fingerprint",
                    "build_version",
                )
            },
        )
    else:
        changes: dict[str, Any] = {
            "artifact_id": "wrong-artifact",
            "weight": 700,
            "style": "italic",
            "file_fingerprint": "sha256:" + "0" * 64,
            "cmap_fingerprint": "sha256:" + "0" * 64,
            "build_version": "wrong-version",
            "missing_clip": "absent-clip",
        }
        binding = replace(
            binding, **{("clip_id" if field == "missing_clip" else field): changes[field]}
        )
    changed = replace(facts, title_bindings=(binding,))
    changed = replace(changed, facts_fingerprint=packaged_font_facts_fingerprint(changed))
    with pytest.raises(AuthoringSourceBindingError, match="^font_glyph_unsupported$"):
        guard(snapshot, load_packaged_font_manifest(), changed)


def test_guard_refusal_precedes_planning_and_staging(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    guard = getattr(source, "_require_resolved_font_bindings", None)
    assert callable(guard), "resolved font guard absent"
    calls = {"plan": 0, "stage": 0}

    def wrong_face(snapshot: Any, fonts: Any, facts: Any) -> None:
        changed = replace(
            facts, title_bindings=(replace(facts.title_bindings[0], font_asset_id=TC),)
        )
        guard(
            snapshot,
            fonts,
            replace(changed, facts_fingerprint=packaged_font_facts_fingerprint(changed)),
        )

    def forbidden_plan(**kwargs: Any) -> Any:
        calls["plan"] += 1
        pytest.fail("planning reached after invalid font binding")

    def forbidden_stage(*args: Any, **kwargs: Any) -> Any:
        calls["stage"] += 1
        pytest.fail("render staging reached after invalid font binding")

    monkeypatch.setattr(source, "_require_resolved_font_bindings", wrong_face)
    monkeypatch.setattr(source, "plan_render", forbidden_plan)
    monkeypatch.setattr(executor, "prepare_render_assets", forbidden_stage)
    with pytest.raises(AuthoringSourceBindingError, match="^font_glyph_unsupported$"):
        bind(title_snapshot("かなカナ"))
    assert calls == {"plan": 0, "stage": 0}
    assert list(tmp_path.iterdir()) == []


def test_uncovered_title_keeps_existing_wire_refusal() -> None:
    # Exercise the real HTTP serializer in-process; no listener, socket or host contact.
    from aiohttp import test_utils, web

    snapshot = title_snapshot("\U0001f600")
    request = AuthoringOutputCreate(
        schema=OUTPUT_CREATE_SCHEMA,
        workspace_handle=snapshot.workspace_handle,
        workspace_revision=snapshot.workspace_revision,
        timeline_revision=snapshot.timeline_revision,
        snapshot_fingerprint=snapshot.public_fingerprint,
        output_profile_id=OUTPUT_PROFILE_ID,
        idempotency_key="uncovered-title-request",
    )
    body = json.dumps(request.to_wire()).encode()
    calls: list[str] = []

    class Body:
        def __init__(self) -> None:
            self.rest = body

        async def read(self, count: int) -> bytes:
            chunk, self.rest = self.rest[:count], self.rest[count:]
            return chunk

    class Authority:
        def create(self, public: AuthoringOutputCreate) -> Any:
            assert public == request
            calls.append("real_binder")
            return bind(snapshot)

    async def scenario() -> None:
        # Only create is exercised here; keep the partial seam calling the real binder.
        edge = AuthoringOutputRoutes(lambda: cast(AuthoringOutputRegistry, Authority()))
        incoming = test_utils.make_mocked_request(
            "POST",
            "/h3-context/v1/authoring/render",
            headers={
                "Host": LOOPBACK_HOST,
                "Origin": LOOPBACK_ORIGIN,
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            },
            payload=Body(),
            transport=ListenerTransport(),
        )
        try:
            response = await edge._handle("create", incoming, web)
            assert response.status == 500
            assert json.loads(response.body) == {
                "schema": OUTPUT_ERROR_SCHEMA,
                "code": "internal_error",
            }
        finally:
            edge.close()

    asyncio.run(scenario())
    assert calls == ["real_binder"]
