"""The child capability is refused before source acquisition, regardless of Windows policy."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, cast

import pytest
from test_m25_authoring_output_service import subject as subject
from test_m25_render_job_leases import image_bound as image_bound
from test_render_native_path_operands import root_at

from comfyui_h3_context.adapters import authoring_render_service as services
from comfyui_h3_context.adapters.authoring_render_store import RenderOutputStore
from comfyui_h3_context.core.authoring_output_protocol import OutputProtocolError
from comfyui_h3_context.core.authoring_render_jobs import RenderJobFailure
from comfyui_h3_context.core.safe_paths import _native_io_path

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows child capability")


@pytest.mark.parametrize("units, supported", [(135, True), (136, True), (137, False), (270, False)])
@pytest.mark.parametrize("extended", [False, True])
def test_longest_stage_file_limit_is_inclusive(
    tmp_path: Path, units: int, supported: bool, extended: bool
) -> None:
    root = root_at(tmp_path, units)
    if extended:
        root = _native_io_path(root, force=True)
    store = RenderOutputStore(root)
    try:
        assert cast(Any, store).native_render_path_supported is supported
        assert store.staging_count == store.retained_count == 0
    finally:
        store.close()


def test_length_counts_utf16_units_and_other_platforms_keep_store_capability(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = root_at(tmp_path, 134) / "\U0001f642"
    _native_io_path(root).mkdir()
    store = RenderOutputStore(root)
    try:
        assert cast(Any, store).native_render_path_supported is False  # 137 UTF-16 units.
        monkeypatch.setattr(sys, "platform", "linux")
        assert cast(Any, store).native_render_path_supported is True
    finally:
        monkeypatch.undo()
        store.close()


def test_public_refusal_precedes_qualification_sources_staging_and_children(
    subject: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry, request, _workspace, service, original_store, backend, _now = subject
    store = RenderOutputStore(root_at(tmp_path, 270))
    calls: list[str] = []

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        calls.append("unexpected work")
        raise AssertionError("refusal must precede backend or source acquisition")

    monkeypatch.setattr(backend, "require_qualified", forbidden)
    monkeypatch.setattr(services, "acquire_render_job_sources", forbidden)
    monkeypatch.setattr(service, "_store", store)
    try:
        with pytest.raises(OutputProtocolError) as error:
            registry.create(request)
        assert error.value.code == "path_too_deep"
        assert error.value.status == 503
        assert str(error.value) == "path_too_deep"
        assert RenderJobFailure("path_too_deep").value == error.value.code
        assert calls == []
        assert service.job_count == store.staging_count == store.retained_count == 0
        assert backend.calls == 0
    finally:
        monkeypatch.setattr(service, "_store", original_store)
        store.close()
