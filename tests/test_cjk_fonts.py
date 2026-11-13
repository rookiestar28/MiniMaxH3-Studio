import json
from pathlib import Path

import pytest

from comfyui_h3_context.adapters import authoring_fonts as fonts


@pytest.mark.parametrize("region", ["TC", "SC", "JP", "KR"])
@pytest.mark.parametrize("weight", ["Regular", "Bold"])
def test_real_cjk_cmap_is_generated_exactly(region: str, weight: str) -> None:
    root = Path(__file__).resolve().parents[1] / "comfyui_h3_context"
    raw = (root / "fonts" / f"NotoSans{region}-{weight}.otf").read_bytes()
    points = fonts._sfnt_codepoints(raw, fonts._sfnt_tables(raw))
    manifest = fonts.load_packaged_font_manifest()
    face = fonts.resolve_packaged_font(
        manifest,
        f"h3.font.noto_sans_{region.lower()}.v1",
        400 if weight == "Regular" else 700,
        "normal",
    )
    assert face._covered_codepoints == points
    assert face.read_verified_bytes() == raw


@pytest.mark.parametrize(
    ("text", "region"), [("繁體中文", "tc"), ("汉语", "sc"), ("日本語かな", "jp"), ("한국어", "kr")]
)
@pytest.mark.parametrize("weight", [400, 700])
def test_regional_whole_text_fallback(text: str, region: str, weight: int) -> None:
    face = fonts.require_text_coverage(
        fonts.load_packaged_font_manifest(), "h3.font.noto_sans.v1", weight, "normal", text
    )
    assert face.font_asset_id == f"h3.font.noto_sans_{region}.v1"


@pytest.mark.parametrize("text", ["繁體中文", "Latin 日本語かな", "한국어"])
def test_cjk_italic_refuses_with_actionable_reason(text: str) -> None:
    with pytest.raises(fonts.AuthoringFontError) as error:
        fonts.require_text_coverage(
            fonts.load_packaged_font_manifest(), "h3.font.noto_sans.v1", 400, "italic", text
        )
    assert error.value.code == "font_italic_unsupported"


def test_emoji_stays_uncovered() -> None:
    with pytest.raises(fonts.AuthoringFontError) as error:
        fonts.require_text_coverage(
            fonts.load_packaged_font_manifest(), "h3.font.noto_sans.v1", 400, "normal", "😀"
        )
    assert error.value.code == "font_glyph_unsupported"


@pytest.mark.parametrize(
    "mutation",
    [
        "styles",
        "license_revision",
        "license_hash",
        "legacy_license",
        "extension",
        "coverage_limit",
        "segment_limit",
        "font_limit",
        "manifest_limit",
    ],
)
def test_relaxed_loader_rules_remain_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    import shutil

    root = Path(__file__).resolve().parents[1] / "comfyui_h3_context"
    shutil.copytree(root / "fonts", tmp_path / "fonts")
    path = tmp_path / "fonts/font_manifest_v1.json"
    wire = json.loads(path.read_bytes())
    if mutation == "styles":
        wire["font_assets"][1]["supported_styles"].append({"weight": 400, "style": "italic"})
    elif mutation == "license_revision":
        wire["font_assets"][1]["license"]["upstream_revision"] = "0" * 40
    elif mutation == "legacy_license":
        wire["license"]["upstream_revision"] = "0" * 40
    elif mutation == "license_hash":
        wire["font_assets"][1]["license"]["file_sha256"] = "sha256:" + "0" * 64
    elif mutation == "segment_limit":
        monkeypatch.setattr(fonts, "_MAX_CMAP_SEGMENTS", 4096)
    elif mutation == "extension":
        wire["font_assets"][1]["faces"][0]["package_path"] = "fonts/NotoSansTC-Regular.woff2"
        shutil.copyfile(
            tmp_path / "fonts/NotoSansTC-Regular.otf", tmp_path / "fonts/NotoSansTC-Regular.woff2"
        )
    elif mutation == "coverage_limit":
        monkeypatch.setattr(fonts, "_MAX_RANGES", 4096)
    elif mutation == "font_limit":
        monkeypatch.setattr(fonts, "_MAX_FONT_BYTES", 8 * 1024 * 1024)
    else:
        monkeypatch.setattr(fonts, "_MAX_MANIFEST_BYTES", 1024)
    path.write_text(json.dumps(wire), encoding="utf-8")
    with pytest.raises(fonts.AuthoringFontError):
        fonts._load_packaged_font_manifest_from_root(tmp_path)


@pytest.mark.parametrize("crlf", [False, True])
def test_generator_reproduces_real_wire_and_rejects_modified_upstream_license(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, crlf: bool
) -> None:
    import shutil

    from scripts import packaged_font_manifest as generator

    source = generator.MANIFEST
    shutil.copytree(source.parent, tmp_path / "fonts")
    path = tmp_path / "fonts/font_manifest_v1.json"
    expected = source.read_bytes()
    if crlf:
        path.write_bytes(expected.replace(b"\n", b"\r\n"))
    monkeypatch.setattr(generator, "MANIFEST", path)
    # The tool resolves fonts relative to the package, matching the real layout.
    assert generator.build() == expected
    license_path = path.parent / "LICENSE-NotoSansCJK-OFL-1.1.txt"
    license_path.write_bytes(license_path.read_bytes() + b"altered license\n")
    with pytest.raises(ValueError, match="reviewed upstream text"):
        generator.build()
