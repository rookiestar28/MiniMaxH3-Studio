"""Exact public Registry recipes for prepared native frame children."""

from dataclasses import replace

import pytest
from test_m26_03_context_materializer import _proposal

from comfyui_h3_context.adapters.comfyui_sidebar_workspace import SidebarWorkspaceRegistry
from comfyui_h3_context.adapters.production_context_materializer import (
    CanonicalProductionMaterializer,
    claim_canonical_production_materialization,
)
from comfyui_h3_context.adapters.production_planning_source import ProductionPlanningSourceSnapshot
from comfyui_h3_context.context_pipeline_nodes import (
    H3ContextCompilerNode,
    H3ContextPlanNode,
    H3ContextValidatorNode,
)
from comfyui_h3_context.context_request_nodes import H3ContextRequestNode, H3ReferenceRegistryNode
from comfyui_h3_context.core.canonical import fingerprint_context_report
from comfyui_h3_context.core.contracts import TaskMode
from comfyui_h3_context.core.native_h3 import build_native_h3_wiring
from comfyui_h3_context.core.registry import MediaMetadata, build_reference_registry
from comfyui_h3_context.core.ui_projection import ExecutionCorrelation


def _public_frame_source(
    sidebar: SidebarWorkspaceRegistry, mode: TaskMode, *, altered_registry: bool = False
) -> ProductionPlanningSourceSnapshot:
    # All frame-role inputs are explicit; no fixture defaults fill a missing role.
    registry = H3ReferenceRegistryNode().build_registry(
        first_frame=object() if mode in {TaskMode.I2VA, TaskMode.FL2VA} else None,
        last_frame=object() if mode in {TaskMode.L2VA, TaskMode.FL2VA} else None,
    )[0]
    if altered_registry:
        registry = build_reference_registry(
            tuple(replace(row, metadata=MediaMetadata(width=640)) for row in registry.assets)
        )
    request = H3ContextRequestNode().build_request(mode, "A synthetic sphere turns.", 8)[0]
    plan = H3ContextPlanNode().build_plan(request, registry)[0]
    document = H3ContextCompilerNode().compile(plan)[2]
    report = H3ContextValidatorNode().validate(plan, document)[1]
    projection = sidebar.publish(
        report,
        build_native_h3_wiring(report),
        ExecutionCorrelation("source.synthetic", "source.shell"),
    )
    return sidebar.snapshot_production_planning_source(
        projection.workspace_id,
        expected_report_revision=projection.report_revision,
        expected_report_fingerprint=projection.report_fingerprint,
    )


@pytest.mark.parametrize("mode", (TaskMode.I2VA, TaskMode.L2VA, TaskMode.FL2VA))
def test_frame_lowering_rebuilds_public_registry_and_whole_plan(mode: TaskMode) -> None:
    sidebar = SidebarWorkspaceRegistry(max_entries=4, ttl_seconds=60)
    source = _public_frame_source(sidebar, mode)
    context, proposal = _proposal(source, parts=(8,))
    segment = proposal.segments[0]
    claim = CanonicalProductionMaterializer(source, workspace_registry=sidebar)(
        context, proposal, segment
    )
    try:
        lowering = claim_canonical_production_materialization(claim).canonical_lowering
        assert lowering is not None
        roles = tuple(row.role.value for row in claim.report.request.reference_registry.assets)
        assert lowering.to_wire() == {
            "schema": "h3.context.production_canonical_lowering.v2",
            "task_mode": mode.value,
            "binding_roles": list(roles),
            "base_report_fingerprint": lowering.base_report_fingerprint,
            "base_report_revision": 0,
            "override_revision": 1,
            "reason": "Materialize approved Production segment prompt",
        }
        request = H3ContextRequestNode().build_request(mode, segment.local_prompt, 8)[0]
        registry = H3ReferenceRegistryNode().build_registry(
            first_frame=object() if "first_frame" in roles else None,
            last_frame=object() if "last_frame" in roles else None,
        )[0]
        rebuilt = H3ContextPlanNode().build_plan(request, registry)[0]
        assert rebuilt == claim.report.plan
        assert (
            fingerprint_context_report(H3ContextCompilerNode().compile(rebuilt)[1])
            == lowering.base_report_fingerprint
        )
    finally:
        claim.release()


def test_frame_lowering_refuses_metadata_the_public_registry_cannot_reproduce() -> None:
    sidebar = SidebarWorkspaceRegistry(max_entries=4, ttl_seconds=60)
    source = _public_frame_source(sidebar, TaskMode.FL2VA, altered_registry=True)
    context, proposal = _proposal(source, parts=(8,))
    claim = CanonicalProductionMaterializer(source, workspace_registry=sidebar)(
        context, proposal, proposal.segments[0]
    )
    try:
        assert claim_canonical_production_materialization(claim).canonical_lowering is None
    finally:
        claim.release()
