"""Real Windows store boundaries; fixtures never use the product's path converter."""

from __future__ import annotations

import errno
import hashlib
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from comfyui_h3_context.adapters import authoring_render_store as render
from comfyui_h3_context.adapters import segment_artifact_store as artifacts
from comfyui_h3_context.core import safe_paths
from comfyui_h3_context.core.safe_paths import UnsafePathError

pytestmark = pytest.mark.skipif(os.name != "nt", reason="real Windows path and handle operations")


def _extended(path: Path) -> Path:
    text = str(path)
    return Path(text if text.startswith("\\\\?\\") else "\\\\?\\" + text)


def _sized_path(parent: Path, length: int, name: str) -> Path:
    remaining = length - len(str(parent)) - len(name) - 2
    assert remaining > 0, (length, len(str(parent)), name)
    while remaining > 100:
        parent /= "a" * 60
        remaining -= 61
    path = parent / ("b" * remaining) / name
    assert len(str(path)) == length
    _extended(path.parent).mkdir(parents=True, exist_ok=True)
    return path


@pytest.mark.parametrize("length", [259, 260, 261, 269, 305])
@pytest.mark.parametrize("long_source", [False, True])
def test_real_no_clobber_publication_at_windows_length_boundaries(
    tmp_path: Path, length: int, long_source: bool
) -> None:
    source = _sized_path(tmp_path, 302, "source.bin") if long_source else tmp_path / "source.bin"
    destination = _sized_path(tmp_path / "target", length, "published.bin")
    body = b"independent-long-path-publication"
    _extended(source).write_bytes(body)
    identity = _extended(source).stat()
    print(f"source_chars={len(str(source))} destination_chars={len(str(destination))}")
    descriptor = artifacts._windows_move_new_file(source, destination)
    try:
        opened = os.fstat(descriptor)
        actual = _extended(destination).stat()
        assert (actual.st_dev, actual.st_ino) == (identity.st_dev, identity.st_ino)
        assert (opened.st_dev, opened.st_ino) == (actual.st_dev, actual.st_ino)
    finally:
        os.close(descriptor)
    assert _extended(destination).read_bytes() == body
    assert not _extended(source).exists()


def test_real_publication_counts_non_bmp_destination_as_utf16_bytes(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = _sized_path(tmp_path, 269, "output-\U0001f642.bin")
    assert len(str(destination).encode("utf-16-le")) // 2 == 270
    source.write_bytes(b"utf16-destination")
    descriptor = artifacts._windows_move_new_file(source, destination)
    os.close(descriptor)
    assert _extended(destination).read_bytes() == b"utf16-destination"


def test_long_destination_collision_and_racing_publish_preserve_the_winner(tmp_path: Path) -> None:
    destination = _sized_path(tmp_path, 269, "winner.bin")
    sources = [tmp_path / "first.bin", tmp_path / "second.bin"]
    for index, source in enumerate(sources):
        source.write_bytes(bytes([index + 1]))

    def publish(source: Path) -> bool:
        try:
            descriptor = artifacts._windows_move_new_file(source, destination)
        except FileExistsError:
            return False
        os.close(descriptor)
        return True

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(publish, sources))
    assert sorted(outcomes) == [False, True]
    winner = _extended(destination).stat()
    payload = _extended(destination).read_bytes()
    loser = sources[outcomes.index(False)]
    with pytest.raises(FileExistsError):
        artifacts._windows_move_new_file(loser, destination)
    assert _extended(destination).stat().st_ino == winner.st_ino
    assert _extended(destination).read_bytes() == payload
    assert loser.exists()


@pytest.mark.parametrize("length", [247, 248, 300])
def test_existing_converter_threshold_drive_unc_and_idempotence(length: int) -> None:
    drive = Path("C:\\" + "a" * (length - 3))
    expected = str(drive) if length < 248 else "\\\\?\\" + str(drive)
    assert artifacts._windows_native_path(drive) == expected
    assert artifacts._windows_native_path(Path(expected)) == expected
    unc = Path("\\\\example.invalid\\share\\" + "a" * length)
    converted = "\\\\?\\UNC\\" + str(unc)[2:]
    assert artifacts._windows_native_path(unc) == converted
    assert artifacts._windows_native_path(Path(converted)) == converted
    with pytest.raises(artifacts.ArtifactStoreError):
        artifacts._windows_native_path(Path("C:\\a\\..\\" + "b" * 260), force=True)


def test_long_render_stage_budget_discard_and_close_use_the_same_logical_paths(
    tmp_path: Path,
) -> None:
    root_length = 262 - sum(
        1 + len(name) for name in ["h3-render-" + "a" * 32, "stage-" + "a" * 32, "a" * 32 + ".mp4"]
    )
    root = _sized_path(tmp_path, root_length, "root")
    _extended(root).mkdir()
    store = render.RenderOutputStore(root)
    try:
        stage = store.begin("render-" + "a" * 32, "sha256:" + "a" * 64)
        path = stage._directory / ("a" * 32 + ".mp4")
        assert len(str(path)) == 262
        _extended(path).write_bytes(b"independent-stage")
        stage._files.add(path.name)
        assert stage.check_budget() == len(b"independent-stage")
        assert not str(stage._directory).startswith("\\\\?\\")
        store.discard(stage)
        assert store.staging_count == 0
        assert not _extended(stage._directory).exists()
    finally:
        store.close()
    assert not _extended(store._session).exists()


def test_long_store_initialization_and_cleanup_enumeration(
    tmp_path: Path,
) -> None:
    root = _sized_path(tmp_path, 280, "root")
    _extended(root).mkdir()
    store = render.RenderOutputStore(root)
    stage = store.begin("render-" + "a" * 32, "sha256:" + "a" * 64)
    stage.write_input(b"bounded-cleanup")
    try:
        store.discard(stage)
        assert store.staging_count == 0
    finally:
        store.close()


@pytest.mark.parametrize("wrapped", [False, True, "validation", "rollback"])
def test_cleanup_cause_keeps_only_category_and_numeric_codes_without_raw_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, wrapped: bool | str
) -> None:
    store = render.RenderOutputStore(tmp_path)
    stage = store.begin("render-" + "b" * 32, "sha256:" + "b" * 64)

    def fault(*_args: Any) -> None:
        if wrapped == "validation":
            raise UnsafePathError("PRIVATE-CLEANUP-SENTINEL")
        raw: Any = PermissionError(errno.EACCES, "PRIVATE-CLEANUP-SENTINEL", "private-first.bin")
        raw.filename2 = "private-second.bin"
        raw.winerror = 32
        if wrapped:
            try:
                raise raw
            except OSError as error:
                raise UnsafePathError("PRIVATE-CLEANUP-SENTINEL") from error
        raise raw

    try:
        with monkeypatch.context() as patch:
            patch.setattr(render, "_remove_directory", fault)
            with pytest.raises(render.RenderStoreError) as caught:
                if wrapped == "rollback":
                    try:
                        raise ValueError("PRIVATE-ROLLBACK-SENTINEL")
                    except ValueError:
                        store.discard(stage)
                else:
                    store.discard(stage)
        error = caught.value
        assert error.code == "cleanup_failed"
        assert error.__context__ is None
        cause = error.__cause__
        assert cause is not None
        assert cause.__context__ is None and cause.__cause__ is None
        assert not hasattr(cause, "filename") and not hasattr(cause, "filename2")
        attributes = vars(cause)
        assert set(attributes) == {"category", "errno", "winerror"}
        assert attributes["category"] == (
            "UnsafePathError" if wrapped == "validation" else "PermissionError"
        )
        assert attributes["errno"] == (None if wrapped == "validation" else errno.EACCES)
        assert attributes["winerror"] == (None if wrapped == "validation" else 32)
        assert all(
            value not in repr(error) + repr(cause) + str(vars(cause))
            for value in [
                "PRIVATE-CLEANUP-SENTINEL",
                "private-first.bin",
                "private-second.bin",
                "PRIVATE-ROLLBACK-SENTINEL",
                str(tmp_path),
            ]
        )
        assert store.staging_count == 1
        store.discard(stage)
        assert store.staging_count == 0
    finally:
        store.close()


def test_native_operand_counts_utf16_and_does_not_prefix_posix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = Path("C:\\" + "\U0001f642" * 123)
    assert len(str(path)) < 248 < len(str(path).encode("utf-16-le")) // 2
    assert str(safe_paths._native_io_path(path)).startswith("\\\\?\\")
    with monkeypatch.context() as patch:
        patch.setattr(os, "name", "posix")
        actual = safe_paths._native_io_path(tmp_path, force=True)
    assert actual is tmp_path
    for value in ["C:" + "a" * 260, "\\\\.\\C:\\", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1"]:
        with pytest.raises(UnsafePathError):
            safe_paths._native_io_path(Path(value), force=True)


def test_native_operand_length_count_preserves_unpaired_utf16_code_units() -> None:
    path = Path("C:\\existing-\ud800.bin")
    assert safe_paths._native_io_path(path) is path


@pytest.mark.parametrize("fault", [None, "callback", "cancel"])
def test_long_render_commit_read_prune_and_rollback(tmp_path: Path, fault: str | None) -> None:
    from test_m25_authoring_render_receipts import _receipt

    root = _sized_path(tmp_path, 280, "root")
    _extended(root).mkdir()
    clock = [1.0]
    store = render.RenderOutputStore(root, clock=lambda: clock[0])
    body = b"complete-synthetic-output"
    receipt = _receipt()
    receipt = replace(
        receipt,
        observed=replace(
            receipt.observed,
            byte_length=len(body),
            output_fingerprint="sha256:" + hashlib.sha256(body).hexdigest(),
        ),
    )
    stage = store.begin("render-" + "c" * 32, receipt.request.fingerprint)
    stage.write_input(b"discard-after-publication")
    _extended(stage.output_path).write_bytes(body)

    def verify(path: Path) -> Any:
        assert not str(path).startswith("\\\\?\\")
        assert _extended(path).read_bytes() == body
        if fault == "cancel":
            stage.cancel()
        return receipt.observed

    def publish(_artifact: render.PrivateRenderArtifact) -> None:
        if fault == "callback":
            raise ValueError("bounded-callback-failure")

    try:
        with pytest.raises(render.RenderStoreError, match="output_unavailable"):
            store.read_output(stage.job_id, receipt.request.fingerprint)
        if fault:
            with pytest.raises(render.RenderStoreError):
                store.commit(stage, receipt, verify_output=verify, on_publish=publish)
            assert store.retained_count == store.staging_count == 0
        else:
            artifact = store.commit(stage, receipt, verify_output=verify, on_publish=publish)
            assert artifact.receipt == receipt
            assert not str(artifact._path).startswith("\\\\?\\")
            assert str(root) not in repr(artifact) + repr(stage) + str(receipt.to_wire())
            assert store.read_output(stage.job_id, receipt.request.fingerprint) == body
            assert store.retained_count == 1 and store.staging_count == 0
            clock[0] += store._limits.retention_seconds
            store.prune()
            assert store.retained_count == 0
    finally:
        store.close()
    assert list(_extended(root).iterdir()) == []


def test_long_render_crash_recovery_preserves_live_session_and_foreign_files(
    tmp_path: Path,
) -> None:
    root = _sized_path(tmp_path, 280, "root")
    _extended(root).mkdir()
    sentinel = root / "foreign.txt"
    _extended(sentinel).write_bytes(b"preserve")
    live = render.RenderOutputStore(root)
    stage = live.begin("render-" + "d" * 32, "sha256:" + "d" * 64)
    path = stage.write_input(b"live-session")
    script = """
import os, sys
from pathlib import Path
from comfyui_h3_context.adapters.authoring_render_store import RenderOutputStore
store = RenderOutputStore(Path(sys.argv[1]))
stage = store.begin('render-' + 'e'*32, 'sha256:' + 'e'*64)
stage.write_input(b'crashed-session')
os._exit(0)
"""
    try:
        result = subprocess.run(
            [sys.executable, "-c", script, str(root)], capture_output=True, timeout=15
        )
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        recovered = render.RenderOutputStore(root)
        try:
            assert _extended(path).read_bytes() == b"live-session"
            assert _extended(sentinel).read_bytes() == b"preserve"
            assert len(list(_extended(root).iterdir())) == 3
        finally:
            recovered.close()
    finally:
        live.close()
    assert [path.name for path in _extended(root).iterdir()] == ["foreign.txt"]


@pytest.mark.parametrize("kind", ["unknown", "hardlink", "junction"])
def test_long_render_cleanup_refuses_foreign_entries_without_deleting_targets(
    tmp_path: Path, kind: str
) -> None:
    from test_segment_artifact_store import _make_directory_link

    root = _sized_path(tmp_path, 280, "root")
    _extended(root).mkdir()
    store = render.RenderOutputStore(root)
    stage = store.begin("render-" + "e" * 32, "sha256:" + "e" * 64)
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    sentinel = foreign / "sentinel.bin"
    sentinel.write_bytes(b"preserve-target")
    leaf = stage._directory / ("foreign.txt" if kind == "unknown" else "a" * 32 + ".bin")
    if kind == "hardlink":
        os.link(sentinel, _extended(leaf))
    elif kind == "junction":
        _make_directory_link(_extended(leaf), foreign)
    else:
        _extended(leaf).write_bytes(b"preserve-unknown")
    try:
        with pytest.raises(
            render.RenderStoreError,
            match="cleanup_failed" if kind == "junction" else "unsafe_store",
        ):
            store.discard(stage)
        assert sentinel.read_bytes() == b"preserve-target"
        assert _extended(leaf).lstat()
        assert store.staging_count == 1
    finally:
        if kind == "junction":
            _extended(leaf).rmdir()
        else:
            _extended(leaf).unlink()
        store.discard(stage)
        store.close()


def test_long_segment_store_publish_reopen_stream_disable_and_recover(tmp_path: Path) -> None:
    from test_segment_artifact_store import _partial, _policy

    root = _sized_path(tmp_path, 280, "root")
    body = b"long-segment-payload"
    store = artifacts.PrivateSegmentArtifactStore(root, policy=_policy(), clock_ms=lambda: 100)
    receipt = store.commit(store.begin(_partial()), body)
    assert store.inspect(receipt).status is artifacts.ArtifactInspectionStatus.REUSABLE
    reopened = artifacts.PrivateSegmentArtifactStore(root, policy=_policy(), clock_ms=lambda: 100)
    assert reopened.read(receipt) == body
    destination = _sized_path(tmp_path, 305, "copy.bin")
    reopened.stream_artifact_into(receipt, destination)
    assert _extended(destination).read_bytes() == body
    assert str(root) not in str(receipt.to_wire())
    assert not str(reopened._root).startswith("\\\\?\\")
    report = reopened.recover()
    assert report.expired_removed == 0
    reopened.disable(purge=True)
    assert reopened.inspect(receipt).status is artifacts.ArtifactInspectionStatus.DISABLED
