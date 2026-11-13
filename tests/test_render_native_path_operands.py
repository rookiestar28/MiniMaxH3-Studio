"""Registry-independent enforcement at the renderer's actual filesystem boundaries."""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from test_m25_authoring_render_probe import envelopes
from test_m25_render_job_leases import image_bound as image_bound

from comfyui_h3_context.adapters import authoring_render_executor as executor
from comfyui_h3_context.adapters import authoring_render_probe as probe
from comfyui_h3_context.adapters import authoring_render_process as process
from comfyui_h3_context.adapters.authoring_render_store import RenderOutputStore
from comfyui_h3_context.core.safe_paths import _native_io_path

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows native operands")


def root_at(base: Path, units: int) -> Path:
    root = base
    while len(str(root).encode("utf-16-le")) // 2 < units:
        remaining = units - len(str(root).encode("utf-16-le")) // 2
        assert remaining > 1
        width = min(60, remaining - 1)
        if remaining - width - 1 == 1:
            width -= 1
        root /= "x" * width
    _native_io_path(root).mkdir(parents=True)
    return root


@pytest.fixture
def boundary(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    seen: list[str] = []
    real_kernel = process._kernel()
    real_lstat, real_stat = Path.lstat, Path.stat

    def check(path: object) -> None:
        value = str(path)
        if len(value.encode("utf-16-le")) // 2 >= 260:
            seen.append(value)
            if not value.startswith("\\\\?\\"):
                raise OSError("ordinary long operand refused by deterministic boundary")

    class Kernel:
        def __getattr__(self, name: str) -> Any:
            return getattr(real_kernel, name)

        def CreateFileW(self, path: str, *args: Any) -> Any:
            check(path)
            return real_kernel.CreateFileW(path, *args)

        def CloseHandle(self, handle: Any) -> Any:
            return real_kernel.CloseHandle(handle)

    def lstat(path: Path, *args: Any, **kwargs: Any) -> Any:
        check(path)
        return real_lstat(path, *args, **kwargs)

    def stat(path: Path, *args: Any, **kwargs: Any) -> Any:
        check(path)
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(Path, "stat", stat)
    for module in (executor, probe, process):
        monkeypatch.setattr(module, "_kernel", lambda: Kernel())
    return seen


@pytest.mark.parametrize("spelling", ["short", "long", "extended"])
def test_stage_and_executable_pins_keep_logical_identity(
    tmp_path: Path, boundary: list[str], spelling: str
) -> None:
    root = root_at(tmp_path, 270) if spelling != "short" else tmp_path
    if spelling == "extended":
        root = _native_io_path(root, force=True)
    store = RenderOutputStore(root)
    control = SimpleNamespace(deadline=time.monotonic() + 10, is_cancelled=lambda: False)
    data = b"private-input-not-an-executable"
    digest = "sha256:" + hashlib.sha256(data).hexdigest()
    try:
        stage = store.begin("render-" + "a" * 32, "sha256:" + "a" * 64)
        path = stage.write_input(data, suffix=".bin")
        with executor._pin_stage_inputs(stage, {path: digest}, control):
            with pytest.raises(PermissionError):
                _native_io_path(path).write_bytes(b"replacement")
        with process.pin_render_executable(path, digest, control=control) as pin:
            assert pin._path == path
            pin.require_current()
            with pytest.raises(PermissionError):
                _native_io_path(path).unlink()
        assert _native_io_path(path).read_bytes() == data
        if spelling != "short":
            assert boundary and all(value.startswith("\\\\?\\") for value in boundary)
    finally:
        store.close()
    assert store.staging_count == store.retained_count == 0


@pytest.mark.parametrize("spelling", ["short", "long", "extended"])
def test_probe_converts_metadata_operands_without_rewriting_child_arguments(
    tmp_path: Path, boundary: list[str], spelling: str
) -> None:
    root = root_at(tmp_path, 270) if spelling != "short" else tmp_path
    if spelling == "extended":
        root = _native_io_path(root, force=True)
    path = root / "output.mp4"
    body = b"\x00\x00\x00 ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"synthetic-media"
    _native_io_path(path).write_bytes(body)
    values = envelopes()
    metadata = json.loads(values["metadata"])
    metadata["format"]["size"] = str(len(body))
    values["metadata"] = json.dumps(metadata).encode()
    responses = iter(values.values())
    calls: list[bool] = []

    class Session:
        def run(self, _pin: Any, arguments: Any, **kwargs: Any) -> Any:
            assert arguments[-1] == str(path)
            assert kwargs["cwd"] == path.parent
            calls.append(True)
            return SimpleNamespace(
                stdout=next(responses),
                exit_code=0,
                diagnostic_bytes=0,
                active_processes=0,
                limits_verified=True,
            )

    control = SimpleNamespace(deadline=time.monotonic() + 10, is_cancelled=lambda: False)
    observed = probe.measure_render_output(
        path=path, probe=cast(Any, object()), session=cast(Any, Session()), control=control
    )
    assert len(calls) == 13
    assert observed.output_fingerprint == "sha256:" + hashlib.sha256(body).hexdigest()
    if spelling != "short":
        assert boundary and all(value.startswith("\\\\?\\") for value in boundary)
    _native_io_path(path).unlink()


def test_executor_output_metadata_uses_native_spelling(
    tmp_path: Path, boundary: list[str], image_bound: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from test_m25_authoring_render_process import Control, command_pin
    from test_m25_render_job_leases import acquire

    bound = image_bound[5]
    sources = acquire(bound)
    store = RenderOutputStore(root_at(tmp_path, 270))
    control = Control()
    calls: list[bool] = []
    try:
        stage = store.begin("render-" + "b" * 32, "sha256:" + "b" * 64)
        prepared = executor.prepare_render_assets(
            plan=bound.plan, sources=sources, stage=stage, control=control
        )

        def render(_session: Any, _pin: Any, arguments: Any, **kwargs: Any) -> Any:
            assert arguments[0] == "-filter_complex_script"
            assert "\\" not in arguments[1] and "/" not in arguments[1]
            assert kwargs["cwd"] == stage.output_path.parent
            assert not str(kwargs["cwd"]).startswith("\\\\?\\")
            calls.append(True)
            _native_io_path(stage.output_path).write_bytes(b"synthetic-output-not-media")
            return SimpleNamespace(
                stdout=b"",
                exit_code=0,
                diagnostic_bytes=0,
                active_processes=0,
                limits_verified=True,
            )

        monkeypatch.setattr(process.WindowsRenderProcessSession, "run", render)
        with command_pin(control) as renderer, process.WindowsRenderProcessSession() as session:
            executor.run_prepared_render(
                plan=bound.plan,
                prepared=prepared,
                renderer=renderer,
                session=session,
                control=control,
            )
            assert session.active_processes == 0
        assert calls == [True]
        assert boundary and all(value.startswith("\\\\?\\") for value in boundary)
    finally:
        sources.release()
        store.close()
