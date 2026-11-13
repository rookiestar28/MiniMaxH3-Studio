"""Regenerate coverage and face facts from the pinned, unmodified packaged SFNT files."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from comfyui_h3_context.adapters.authoring_fonts import (  # noqa: E402
    _codepoint_bytes,
    _codepoint_ranges,
    _git_blob_sha1,
    _sfnt_codepoints,
    _sfnt_names,
    _sfnt_tables,
    _sha256,
)

MANIFEST = ROOT / "comfyui_h3_context/fonts/font_manifest_v1.json"
CJK_REVISION = "523d033d6cb47f4a80c58a35753646f5c3608a78"  # pragma: allowlist secret
CJK_BLOBS = {
    "TC": (
        "63c3422382411b4d132644794fd432c53faa2882",  # pragma: allowlist secret
        "3a3f5ed878b786e5cea68d2c2b1c3496a22ab2c1",  # pragma: allowlist secret
    ),  # pragma: allowlist secret
    "SC": (
        "fc0fda9394367c16c1af7555a2ae4d5e2e6a6f02",  # pragma: allowlist secret
        "bcc11bc30e65b69b9e5a508c3e2138197c5543cf",  # pragma: allowlist secret
    ),  # pragma: allowlist secret
    "JP": (
        "4af556abb9cc42e585aab777b01857246a110746",  # pragma: allowlist secret
        "40262777db707145a08795e0e62ab5956eafe4b6",  # pragma: allowlist secret
    ),  # pragma: allowlist secret
    "KR": (
        "b8c11425a25c74dac1b51b28341ff1ef379f2ffa",  # pragma: allowlist secret
        "497914abec9fcf714fedebb7b893e63657d19124",  # pragma: allowlist secret
    ),  # pragma: allowlist secret
}


def build() -> bytes:
    wire = json.loads(MANIFEST.read_bytes())
    license_payload = (
        (MANIFEST.parent / "LICENSE-NotoSansCJK-OFL-1.1.txt").read_bytes().replace(b"\r\n", b"\n")
    )
    # Pin the same-tag OFL plus the copyright extracted from the pinned font name table.
    if (
        _sha256(license_payload)
        != "sha256:af55b908a0ccf969b7bdd0e6cac6f4866a7ed0d1aeb9c7b29516ca0d24422981"
    ):
        raise ValueError("packaged CJK license differs from the reviewed upstream text")
    primary = wire["font_assets"][0]
    primary["supported_styles"] = [
        {"weight": face["weight"], "style": face["style"]} for face in primary["faces"]
    ]
    primary["license"] = wire["license"]
    primary["source_repository"] = "notofonts/latin-greek-cyrillic"
    assets = [primary]
    profiles = []
    seen_profiles = set()
    for region, blobs in CJK_BLOBS.items():
        license_path = "fonts/LICENSE-NotoSansCJK-OFL-1.1.txt"
        license_wire = {
            "spdx_id": "OFL-1.1",
            "package_path": license_path,
            "file_sha256": _sha256(
                (MANIFEST.parent.parent / license_path).read_bytes().replace(b"\r\n", b"\n")
            ),
            "upstream_revision": CJK_REVISION,
        }
        faces = []
        for (weight, name), blob in zip(((400, "Regular"), (700, "Bold")), blobs, strict=True):
            path = f"fonts/NotoSans{region}-{name}.otf"
            payload = (MANIFEST.parent.parent / path).read_bytes()
            if _git_blob_sha1(payload) != blob:
                raise ValueError("packaged CJK font differs from its pinned upstream blob")
            names = _sfnt_names(payload, _sfnt_tables(payload))
            faces.append(
                {
                    "artifact_id": f"h3.font.noto_sans_{region.lower()}.{name.lower()}.v1",
                    "package_path": path,
                    "weight": weight,
                    "style": "normal",
                    "upstream_git_blob_sha1": blob,
                    "postscript_name": names[6],
                    "subfamily_name": names[2],
                    "build_version": names[5],
                    "coverage_profile_id": f"h3.font.coverage.noto_sans_{region.lower()}_v2_004.v1",
                }
            )
        assets.append(
            {
                "font_asset_id": f"h3.font.noto_sans_{region.lower()}.v1",
                "family_name": f"Noto Sans {region}",
                "release_id": "NotoSansCJK-v2.004",
                "build_revision": CJK_REVISION,
                "distribution_revision": CJK_REVISION,
                "source_repository": "notofonts/noto-cjk",
                "license": license_wire,
                "supported_styles": [
                    {"weight": 400, "style": "normal"},
                    {"weight": 700, "style": "normal"},
                ],
                "faces": faces,
            }
        )
    for asset in assets:
        for face in asset["faces"]:
            payload = (MANIFEST.parent.parent / face["package_path"]).read_bytes()
            points = sorted(_sfnt_codepoints(payload, _sfnt_tables(payload)))
            fingerprint = _sha256(_codepoint_bytes(points))
            face.update(
                size_bytes=len(payload), file_sha256=_sha256(payload), cmap_sha256=fingerprint
            )
            profile_id = face["coverage_profile_id"]
            if profile_id not in seen_profiles:
                profiles.append(
                    {
                        "profile_id": profile_id,
                        "codepoint_count": len(points),
                        "ranges": _codepoint_ranges(points),
                        "codepoint_sha256": fingerprint,
                    }
                )
                seen_profiles.add(profile_id)
    wire["font_assets"] = assets
    wire["fallback_order"] = [asset["font_asset_id"] for asset in assets]
    wire["coverage_profiles"] = profiles
    text = json.dumps(wire, ensure_ascii=False, indent=2) + "\n"
    # Deterministic one-line numeric pairs keep the 5,055-range TC profile within the bounded wire.
    text = re.sub(r"\[\n\s+(\d+),\n\s+(\d+)\n\s+\]", r"[\1, \2]", text)
    return text.encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--write", action="store_true")
    modes.add_argument("--check", action="store_true")
    args = parser.parse_args()
    payload = build()
    if args.write:
        MANIFEST.write_bytes(payload)
    elif MANIFEST.read_bytes() != payload:
        print("packaged font manifest is stale")
        return 1
    print(f"packaged font manifest: {len(payload)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
