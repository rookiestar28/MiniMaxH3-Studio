"""Cross-end preset values retain the unchanged title and renderer contracts."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path

import pytest
from test_m25_composition_contract import fixture_snapshot, resign

from comfyui_h3_context.adapters.authoring_renderer_qualification import load_renderer_qualification
from comfyui_h3_context.core.composition_contract import decode_public_snapshot

ROOT = Path(__file__).resolve().parents[1]
PRESETS = ROOT / "tests/fixtures/title_style_presets.json"


def test_preset_alternates_have_exact_owners_and_named_history_journeys() -> None:
    manifest = json.loads(
        (ROOT / "governance/contracts/nle_control_coverage_manifest_v1.json").read_bytes()
    )
    rows = manifest["command_rows"] + manifest["non_command_rows"]
    canonical = {row["control_selector"] for row in rows}
    journey = (ROOT / "frontend/tests/e2e/journeys/titleStylePresets.spec.ts").read_text(
        encoding="utf-8"
    )
    compact = re.sub(r"\s+", "", journey)
    entries = {
        "title.insert_preset": (
            "title.insert",
            "preset insert reuses a text track in one intent with refusal recovery and history",
        ),
        "text.apply_preset": (
            "text.style",
            "preset apply replaces the accepted style in one intent with no-op refusal and history",
        ),
    }
    for control, (owner, title) in entries.items():
        selector = f'[data-h3-nle-control="{control}"]'
        assert selector not in canonical
        assert [row["operation_id"] for row in rows if selector in row["alternate_selectors"]] == [
            owner
        ]
        assert re.search(r"\btest\(\s*" + re.escape(json.dumps(title)) + r"\s*,", journey)
        assert selector in journey
    assert '["create_track","insert_title_clip"]:["insert_title_clip"]' in compact
    assert 'toEqual(["set_text_style"])' in journey
    for assertion in (
        "toHaveLength(0)",
        "toHaveLength(1)",
        "history.undo",
        "history.redo",
        "toBeDisabled()",
    ):
        assert assertion in journey


@pytest.mark.parametrize("index", range(8))
def test_catalogue_styles_decode_without_contract_extensions(index: int) -> None:
    presets = json.loads(PRESETS.read_text(encoding="utf-8"))
    assert len(presets) == len({row["id"] for row in presets}) == 8
    wire = fixture_snapshot()
    original = wire["clips"][3]["text"]
    for key in ("stroke", "shadow", "background_padding_px"):
        original.pop(key, None)
    original.update(presets[index]["style"])
    wire = resign(wire)
    assert decode_public_snapshot(wire).to_wire() == wire


def test_presets_leave_packaged_qualification_loadable() -> None:
    assert load_renderer_qualification() is not None


def test_embedded_preset_faces_equal_packaged_files_and_manifest() -> None:
    manifest = json.loads((ROOT / "comfyui_h3_context/fonts/font_manifest_v1.json").read_bytes())
    latin = next(
        row for row in manifest["font_assets"] if row["font_asset_id"] == "h3.font.noto_sans.v1"
    )
    bundle = (ROOT / "comfyui_h3_context/web/h3-context-sidebar.js").read_text(encoding="utf-8")
    embedded = {
        base64.b64decode(match)
        for match in re.findall(r"data:font/(?:ttf|sfnt);base64,([A-Za-z0-9+/=]+)", bundle)
    }
    for weight in (400, 700):
        face = next(
            row for row in latin["faces"] if row["weight"] == weight and row["style"] == "normal"
        )
        body = (ROOT / "comfyui_h3_context" / face["package_path"]).read_bytes()
        assert any(body == candidate for candidate in embedded), face["artifact_id"]
        assert "sha256:" + hashlib.sha256(body).hexdigest() == face["file_sha256"]
        assert len(body) == face["size_bytes"]
