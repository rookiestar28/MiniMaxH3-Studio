"""Managed frame-sequence boundary and execution regressions."""

from dataclasses import replace
from itertools import count
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

import pytest
import test_m26_03_prepared_context as prepared_helpers
from test_m26_03_context_materializer import _proposal

from comfyui_h3_context.adapters import managed_sequence_service as service_module
from comfyui_h3_context.adapters.comfyui_sidebar_workspace import SidebarWorkspaceRegistry
from comfyui_h3_context.adapters.production_context_materializer import (
    CanonicalProductionMaterializer,
    ProductionCanonicalLoweringV1,
    claim_canonical_production_materialization,
)
from comfyui_h3_context.core.canonical import canonical_bytes, canonical_fingerprint


def _t2va_baseline_bytes() -> bytes:
    tokens = count(1)
    with patch("secrets.token_urlsafe", side_effect=lambda _size: f"{next(tokens):043d}"):
        sidebar = SidebarWorkspaceRegistry(max_entries=4, ttl_seconds=60)
        service, request, source, context, proposal = prepared_helpers._prepared_service(sidebar)
        prepared = service.read_prepared_child_context(request)
        claim = CanonicalProductionMaterializer(source, workspace_registry=sidebar)(
            context, proposal, proposal.segments[0]
        )
        snapshot = claim_canonical_production_materialization(claim)
        result = canonical_bytes(
            {
                "intent_graph": snapshot.report.plan.intent_graph.to_wire(),
                "report_fingerprint": snapshot.report_fingerprint,
                "native_wiring": snapshot.wiring.to_wire(),
                "canonical_lowering": cast(
                    ProductionCanonicalLoweringV1, snapshot.canonical_lowering
                ).to_wire(),
                "prepared_context": prepared.to_wire(),
            }
        )
        claim.release()
        return result


def test_t2va_exact_baseline_bytes() -> None:
    baseline = Path(__file__).parent / "fixtures" / "managed_t2va_baseline.json"
    assert _t2va_baseline_bytes() == baseline.read_bytes()


def test_prepared_context_cjk_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    # Exercise the real canonical materializer and service response cap. ASCII-only
    # fixtures cannot expose a byte cap that is smaller than the admitted character cap.
    prompt = "\u754c" * 4_096
    monkeypatch.setattr(
        prepared_helpers,
        "_proposal",
        lambda source, *, parts: _proposal(source, parts=parts, texts=(prompt,)),
    )
    sidebar = SidebarWorkspaceRegistry(max_entries=4, ttl_seconds=60)
    service, request, _source, _context, proposal = prepared_helpers._prepared_service(sidebar)
    prepared = service.read_prepared_child_context(request)
    assert prepared.canonical_prompt == proposal.segments[0].local_prompt
    assert prepared.canonical_prompt.count("\u754c") == 4_096
    assert len(canonical_bytes(prepared.to_wire())) <= 32 * 1_024


@pytest.mark.parametrize("extra_byte", (0, 1))
def test_prepared_context_response_byte_boundary(
    monkeypatch: pytest.MonkeyPatch, extra_byte: int
) -> None:
    sidebar = SidebarWorkspaceRegistry(max_entries=4, ttl_seconds=60)
    service, request, *_ = prepared_helpers._prepared_service(sidebar)
    constructor = service_module.ManagedPreparedContextV1

    def sized_context(**kwargs: Any) -> service_module.ManagedPreparedContextV1:
        value = constructor(**kwargs)
        empty = replace(
            value, canonical_prompt="x", canonical_prompt_fingerprint=canonical_fingerprint("x")
        )
        overhead = len(canonical_bytes(empty.to_wire())) - 1
        text = "x" * (32 * 1_024 + extra_byte - overhead)
        result = replace(
            value, canonical_prompt=text, canonical_prompt_fingerprint=canonical_fingerprint(text)
        )
        assert len(canonical_bytes(result.to_wire())) == 32 * 1_024 + extra_byte
        return result

    # Isolate the serialization boundary after the real held-authority/report join. The
    # injected result is a valid closed response; execution prompt limits have separate tests.
    monkeypatch.setattr(service_module, "ManagedPreparedContextV1", sized_context)
    if extra_byte:
        with pytest.raises(service_module.ManagedSequenceServiceError, match="^response_size$"):
            service.read_prepared_child_context(request)
    else:
        assert (
            len(canonical_bytes(service.read_prepared_child_context(request).to_wire()))
            == 32 * 1_024
        )
