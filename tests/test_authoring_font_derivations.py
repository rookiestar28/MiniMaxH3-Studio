from __future__ import annotations

import json
import os
import shutil
from collections import Counter
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError
from pathlib import Path
from threading import Barrier
from typing import Any

import pytest

from comfyui_h3_context.adapters import authoring_fonts as fonts


def package_copy(destination: Path) -> Path:
    source = Path(fonts.__file__).resolve().parents[1]
    shutil.copytree(source / "fonts", destination / "fonts")
    return destination


def test_warm_validation_rechecks_bytes_without_repeating_font_derivations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = package_copy(tmp_path / "package")
    reads: Counter[str] = Counter()
    hashes: Counter[str] = Counter()
    parsed: list[int] = []
    read, digest, cmap = fonts._read_bounded, fonts._sha256, fonts._sfnt_codepoints

    def observe_read(path: Path, maximum: int, missing_code: str) -> bytes:
        result = read(path, maximum, missing_code)
        reads[path.name] += 1
        return result

    def observe_digest(payload: bytes) -> str:
        result = digest(payload)
        hashes[result] += 1
        return result

    def observe_cmap(payload: bytes, tables: Mapping[bytes, tuple[int, int]]) -> frozenset[int]:
        result = cmap(payload, tables)
        parsed.append(len(result))
        return result

    monkeypatch.setattr(fonts, "_read_bounded", observe_read)
    monkeypatch.setattr(fonts, "_sha256", observe_digest)
    monkeypatch.setattr(fonts, "_sfnt_codepoints", observe_cmap)
    first = fonts._load_packaged_font_manifest_from_root(root)
    assert len(parsed) == len(first.faces) == 12
    second = fonts._load_packaged_font_manifest_from_root(root)
    assert first == second
    for face in first.faces:
        assert reads[Path(face.package_path).name] == 2
        assert hashes[face.file_fingerprint] == 2
    assert sum(reads.values()) == 38
    assert len(parsed) == 12, "warm verified bytes must reuse their pure font derivations"


def test_shipped_package_is_cache_eligible(tmp_path: Path, record_property: Any) -> None:
    root = package_copy(tmp_path / "package")
    result = fonts._load_packaged_font_manifest_from_root(root)
    entry = fonts._font_derivation_entry
    assert entry is not None and entry.manifest is result, (
        "shipped font package must remain cache-eligible; review cache caps after package growth"
    )
    assert len(entry.reads) == 19
    size = fonts._retained_font_bytes(entry)
    recipe_size = fonts._retained_font_bytes(entry.reads)
    assert size <= 32 * 1024 * 1024
    assert recipe_size <= 64 * 1024
    record_property("cache_retained_bytes", size)
    record_property("cache_recipe_bytes", recipe_size)


def test_warm_same_stat_font_tampering_is_reverified_and_recovers(tmp_path: Path) -> None:
    root = package_copy(tmp_path / "package")
    original = fonts._load_packaged_font_manifest_from_root(root)
    path = root / original.faces[0].package_path
    body, stamp = path.read_bytes(), path.stat()
    changed = bytearray(body)
    changed[-1] ^= 1
    path.write_bytes(changed)
    os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    assert path.stat().st_size == stamp.st_size
    assert path.stat().st_mtime_ns == stamp.st_mtime_ns
    with pytest.raises(fonts.AuthoringFontError) as error:
        fonts._load_packaged_font_manifest_from_root(root)
    assert error.value.code == "font_artifact_hash_mismatch"
    assert str(root) not in str(error.value)
    path.write_bytes(body)
    assert fonts._load_packaged_font_manifest_from_root(root) == original


@pytest.mark.parametrize("mutation", ["whitespace", "crlf", "invalid"])
def test_warm_changed_manifest_uses_original_validation(tmp_path: Path, mutation: str) -> None:
    root = package_copy(tmp_path / "package")
    original = fonts._load_packaged_font_manifest_from_root(root)
    path = root / "fonts/font_manifest_v1.json"
    body = path.read_bytes()
    if mutation == "invalid":
        wire = json.loads(body)
        wire["fallback_order"] = []
        path.write_text(json.dumps(wire), encoding="utf-8")
        with pytest.raises(fonts.AuthoringFontError) as error:
            fonts._load_packaged_font_manifest_from_root(root)
        assert error.value.code == "font_manifest_invalid"
        path.write_bytes(body)
        assert fonts._load_packaged_font_manifest_from_root(root) == original
    else:
        path.write_bytes(body + b" " if mutation == "whitespace" else body.replace(b"\n", b"\r\n"))
        current = fonts._load_packaged_font_manifest_from_root(root)
        assert current is not original
        assert current.manifest_fingerprint == original.manifest_fingerprint
        if mutation == "whitespace":
            assert current.package_fingerprint != original.package_fingerprint
        else:
            assert current.package_fingerprint == original.package_fingerprint


@pytest.mark.parametrize("mutation", ["crlf", "content", "lone_cr", "space"])
def test_warm_licence_bytes_are_revalidated(tmp_path: Path, mutation: str) -> None:
    root = package_copy(tmp_path / "package")
    original = fonts._load_packaged_font_manifest_from_root(root)
    path = root / "fonts/LICENSE-NotoSansCJK-OFL-1.1.txt"
    body = path.read_bytes()
    replacements = {
        "crlf": body.replace(b"\n", b"\r\n"),
        "content": body.replace(b"Copyright", b"copyright", 1),
        "lone_cr": body.replace(b"\n", b"\r", 1),
        "space": body + b" ",
    }
    path.write_bytes(replacements[mutation])
    if mutation == "crlf":
        current = fonts._load_packaged_font_manifest_from_root(root)
        assert current is not original
        assert current == original
    else:
        with pytest.raises(fonts.AuthoringFontError) as error:
            fonts._load_packaged_font_manifest_from_root(root)
        assert error.value.code == "font_license_hash_mismatch"
    path.write_bytes(body)
    assert fonts._load_packaged_font_manifest_from_root(root) == original


@pytest.mark.parametrize("kind", ["manifest", "license", "font"])
def test_warm_replay_uses_current_byte_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    root = package_copy(tmp_path / "package")
    original = fonts._load_packaged_font_manifest_from_root(root)
    name = {
        "manifest": "_MAX_MANIFEST_BYTES",
        "license": "_MAX_LICENSE_BYTES",
        "font": "_MAX_FONT_BYTES",
    }[kind]
    monkeypatch.setattr(fonts, name, 1)
    with pytest.raises(fonts.AuthoringFontError) as error:
        fonts._load_packaged_font_manifest_from_root(root)
    assert error.value.code == "font_manifest_invalid"
    assert original.faces


@pytest.mark.parametrize("mutation", ["missing", "truncated", "link_escape"])
def test_warm_filesystem_guards_remain_live(tmp_path: Path, mutation: str) -> None:
    root = package_copy(tmp_path / "package")
    original = fonts._load_packaged_font_manifest_from_root(root)
    path = root / original.faces[0].package_path
    body = path.read_bytes()
    if mutation == "missing":
        path.unlink()
    elif mutation == "truncated":
        path.write_bytes(b"")
    elif os.name == "nt":
        import _winapi

        outside = tmp_path / "outside-fonts"
        directory = root / "fonts"
        assert directory.resolve().is_relative_to(tmp_path.resolve())
        assert outside.resolve().is_relative_to(tmp_path.resolve())
        directory.rename(outside)
        # A real junction needs no symlink privilege and exercises the same root escape guard.
        junction = getattr(_winapi, "CreateJunction")  # noqa: B009 - absent from Linux stubs.
        junction(str(outside), str(directory))
    else:
        outside = tmp_path / "outside.ttf"
        outside.write_bytes(body)
        path.unlink()
        path.symlink_to(outside)
    with pytest.raises(fonts.AuthoringFontError) as error:
        fonts._load_packaged_font_manifest_from_root(root)
    expected = "font_artifact_missing" if mutation == "missing" else "font_manifest_invalid"
    assert error.value.code == expected
    assert str(root) not in str(error.value)


def test_same_bytes_in_distinct_roots_never_share_root_bound_results(tmp_path: Path) -> None:
    left, right = package_copy(tmp_path / "left"), package_copy(tmp_path / "right")
    first = fonts._load_packaged_font_manifest_from_root(left)
    second = fonts._load_packaged_font_manifest_from_root(right)
    again = fonts._load_packaged_font_manifest_from_root(left)
    assert first == second == again
    assert first is not second and first is not again
    for result, root in [(first, left), (second, right), (again, left)]:
        assert all(face._filesystem_path.is_relative_to(root) for face in result.faces)


def test_concurrent_cold_warm_and_root_replacement_are_complete(tmp_path: Path) -> None:
    roots = [package_copy(tmp_path / name) for name in ("left", "right")]
    # Both waits are hang guards, not performance budgets. Under the backend job's coverage
    # tracing on Python 3.10 this test took 126.3 s on Linux, against 2.4 s untraced, so each
    # wait allows 900 s (at least five times the traced run).
    barrier = Barrier(4)

    def load(index: int) -> list[fonts.PackagedFontManifest]:
        root = roots[index % 2]
        results = []
        for _ in range(2):
            barrier.wait(timeout=900)
            result = fonts._load_packaged_font_manifest_from_root(root)
            assert len(result.faces) == 12
            assert all(face._filesystem_path.is_relative_to(root) for face in result.faces)
            assert result.faces[0].read_verified_bytes()
            results.append(result)
        return results

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(load, index) for index in range(4)]
        batches = [future.result(timeout=900) for future in futures]
    flat = [result for batch in batches for result in batch]
    assert all(result == flat[0] for result in flat)
    with pytest.raises(FrozenInstanceError):
        # Exercise the actual frozen-field runtime refusal despite the static read-only type.
        setattr(flat[0].faces[0], "file_fingerprint", "changed")  # noqa: B010


@pytest.mark.parametrize(
    "limit",
    ["_MAX_CACHED_FACES", "_MAX_CACHED_READS", "_MAX_CACHED_BYTES", "_MAX_CACHED_RECIPE_BYTES"],
)
def test_cache_budget_bypass_preserves_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, limit: str
) -> None:
    root = package_copy(tmp_path / "package")
    monkeypatch.setattr(fonts, limit, 1)
    first = fonts._load_packaged_font_manifest_from_root(root)
    second = fonts._load_packaged_font_manifest_from_root(root)
    assert first == second and first is not second
    entry = fonts._font_derivation_entry
    assert entry is None or entry.manifest is not first
