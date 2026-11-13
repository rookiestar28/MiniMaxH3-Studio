"""Real Windows durable-state boundaries and process-crash recovery."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from test_durable_state_store import OWNER, metadata
from test_store_long_paths import _extended, _sized_path

from comfyui_h3_context.adapters import durable_state_store as durable
from comfyui_h3_context.core.durable_workspace_state import DurableStateError

pytestmark = pytest.mark.skipif(os.name != "nt", reason="real Windows path and handle operations")

_REVISION_NAME = "revision-" + "0" * 16 + "-" + "0" * 64 + ".json"
_CRASH_CHILD = """
from pathlib import Path
import os, sys
import comfyui_h3_context.adapters.durable_state_store as module
from comfyui_h3_context.core.durable_workspace_state import decode_record
root, owner, cut = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
store = module.DurableStateStore(root, owner, clock_ms=lambda: 3000)
row = decode_record({'record_id':'record_'+'00000000000000000000000000000001',
 'kind':'production','created_at_ms':1000,'closed_at_ms':None,'segment_count':1,
 'state':'workspace_active','last_transition':None,
 'revisions':{'workspace':2,'reference':None,'timeline':None,'context':None,'transition':0}})
write, publish = module._write_new_file, module._replace_manifest
def crash_write(path, payload):
    selected = (path.name.startswith('revision-') if cut=='partial-snapshot'
                else path.name=='manifest.next.json')
    if selected and cut in {'partial-snapshot','partial-manifest'}:
        original = os.write
        def partial(fd, data):
            original(fd, data[:13])
            os._exit(71)
        os.write = partial
    write(path, payload)
    if ((cut=='snapshot-closed' and path.name.startswith('revision-'))
        or (cut=='manifest-closed' and path.name=='manifest.next.json')):
        os._exit(72)
def crash_publish(source, target):
    publish(source, target)
    if cut=='manifest-published':
        os._exit(73)
module._write_new_file, module._replace_manifest = crash_write, crash_publish
manifest, _ = store.read()
store.save((row,), expected_revision=manifest.revision)
sys.exit(5)
"""


def _units(path: Path) -> int:
    return len(str(path).encode("utf-16-le")) // 2


def _root_for_boundary(parent: Path, length: int, boundary: str) -> Path:
    suffix = Path("workspace-state") / "v1" / OWNER
    if boundary == "revision":
        suffix /= _REVISION_NAME
    root_length = length - 1 - _units(suffix)
    root = _sized_path(parent, root_length, "private")
    assert _units(root / suffix) == length
    return root


def _store(root: Path) -> durable.DurableStateStore:
    return durable.DurableStateStore(root, OWNER, clock_ms=lambda: 2000)


@pytest.mark.parametrize("boundary", ["owner", "revision"])
@pytest.mark.parametrize("length", [259, 260, 261])
def test_durable_state_publish_recover_prune_at_length_boundaries(
    tmp_path_factory: pytest.TempPathFactory,
    monkeypatch: pytest.MonkeyPatch,
    boundary: str,
    length: int,
) -> None:
    root = _root_for_boundary(tmp_path_factory.mktemp("durable"), length, boundary)
    _exercise_lifecycle(root, monkeypatch)


def test_durable_state_short_path_has_the_same_lifecycle(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path_factory.mktemp("short") / "private"
    assert _units(root / "workspace-state" / "v1" / OWNER / _REVISION_NAME) < 248
    _exercise_lifecycle(root, monkeypatch)


def _exercise_lifecycle(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = _store(root)
    try:
        assert store.read()[0].revision == 0
        store.set_enabled(True, expected_revision=0)
        first = store.save((metadata(),), expected_revision=1)
        before = store.read()

        def interrupted(source: Path, target: Path) -> None:
            raise OSError("injected commit interruption")

        with monkeypatch.context() as patch:
            patch.setattr(durable, "_replace_manifest", interrupted)
            with pytest.raises(DurableStateError) as failure:
                store.save((metadata(revision=2),), expected_revision=first.revision)
        assert str(root) not in str(failure.value)
        assert str(root) not in repr(failure.value)
        assert store.read() == before
        pending = store.owner_directory / "manifest.next.json"
        assert _extended(pending).is_file()
        second = store.save((metadata(revision=3),), expected_revision=first.revision)
        third = store.save((metadata(revision=4),), expected_revision=second.revision)
        manifest, current = store.read()
        assert current == third and manifest.previous is not None
        files = store._files(store.owner_directory)
        assert len([path for path, _ in files if path.name.startswith("revision-")]) == 2
        assert store._owners() == (store.owner_directory,)
        assert not _extended(pending).exists()
        assert str(root) not in json.dumps(manifest.to_wire())
        assert str(root) not in repr(store)
        assert not str(store.owner_directory).startswith("\\\\?\\")
        store.close()
        reopened = _store(root)
        try:
            assert reopened.read() == (manifest, third)
            reset = reopened.reset(expected_revision=manifest.revision)
            assert not reset.enabled and reopened.read()[1] is None
            assert not any(
                path.name.startswith("revision-")
                for path, _ in reopened._files(reopened.owner_directory)
            )
        finally:
            reopened.close()
        print(
            f"owner_utf16={_units(store.owner_directory)} "
            f"revision_utf16={_units(store.owner_directory / _REVISION_NAME)} lifecycle=closed"
        )
    finally:
        store.close()


@pytest.mark.parametrize("owner_length", [261, 305])
@pytest.mark.parametrize(
    "cut",
    [
        "partial-snapshot",
        "snapshot-closed",
        "partial-manifest",
        "manifest-closed",
        "manifest-published",
    ],
)
def test_durable_state_process_crash_cuts_past_max_path(
    tmp_path: Path, owner_length: int, cut: str
) -> None:
    root = _root_for_boundary(tmp_path, owner_length, "owner")
    store = _store(root)
    assert _units(store.owner_directory) == owner_length >= 261
    assert _units(store.owner_directory / _REVISION_NAME) >= 261
    try:
        store.set_enabled(True, expected_revision=0)
        before = store.save((metadata(),), expected_revision=1)
    finally:
        store.close()
    result = subprocess.run(
        [sys.executable, "-E", "-s", "-B", "-c", _CRASH_CHILD, str(root), OWNER, cut],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode in (71, 72, 73), result.stdout + result.stderr
    reopened = _store(root)
    try:
        recovered = reopened.read()[1]
        assert recovered is not None
        if cut == "manifest-published":
            assert recovered.records == (metadata(revision=2),)
            assert recovered.revision > before.revision
        else:
            assert recovered == before
        if cut.startswith("partial-"):
            with pytest.raises(DurableStateError) as failure:
                reopened.save((metadata(revision=3),), expected_revision=recovered.revision)
            assert str(root) not in repr(failure.value)
            assert reopened.read()[1] == before
        else:
            next_state = reopened.save(
                (metadata(revision=3),), expected_revision=recovered.revision
            )
            assert reopened.read()[1] == next_state
        print(
            f"owner_utf16={_units(reopened.owner_directory)} "
            f"revision_utf16={_units(reopened.owner_directory / _REVISION_NAME)} "
            f"cut={cut} child_exit={result.returncode}"
        )
    finally:
        reopened.close()


def test_long_durable_state_keeps_single_link_refusal(tmp_path: Path) -> None:
    root = _root_for_boundary(tmp_path, 305, "owner")
    store = _store(root)
    try:
        store.set_enabled(True, expected_revision=0)
        store.save((metadata(),), expected_revision=1)
        manifest = store.read()[0]
        assert manifest.latest is not None
        snapshot = store.owner_directory / manifest.latest.file_name
        foreign = tmp_path / "foreign-link.json"
        os.link(_extended(snapshot), foreign)
        try:
            with pytest.raises(DurableStateError, match="storage_unsafe") as failure:
                store.read()
            assert str(root) not in repr(failure.value)
            assert str(foreign) not in repr(failure.value)
            assert foreign.read_bytes() == _extended(snapshot).read_bytes()
        finally:
            foreign.unlink()
    finally:
        store.close()
