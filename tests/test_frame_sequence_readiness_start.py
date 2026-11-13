"""Real recipe qualification and retryable concrete admission share the same owned plan."""

import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import pytest
from native_source_doubles import composition_observation, observed_source
from test_generation_profile import observation
from test_m23_18_input_geometry import _png, _request
from test_m26_03_planning_service import action, prepared_proposal, selectors
from test_m26_04_qualification_producer import _install_loader_inventory
from test_sequence_media_bindings import binding_wire

from comfyui_h3_context.adapters import comfyui_generation_profile, composition_root
from comfyui_h3_context.adapters import managed_sequence_service as managed_api
from comfyui_h3_context.adapters.comfyui_input_geometry import InputGeometryRegistry
from comfyui_h3_context.adapters.comfyui_production_workspace import ProductionWorkspaceRegistry
from comfyui_h3_context.adapters.comfyui_sequence_coordinator import SequenceCoordinatorRegistry
from comfyui_h3_context.adapters.comfyui_sidebar_workspace import SidebarWorkspaceRegistry
from comfyui_h3_context.core import build_native_h3_wiring
from comfyui_h3_context.core.managed_sequence import ManagedModeQualificationV1
from comfyui_h3_context.core.native_guide import GUIDE_REQUIRED_INPUTS, NativeGuideCapability
from comfyui_h3_context.core.native_keyframe_structure import (
    PRODUCTION_MANIFEST,
    KeyframeStructureReason,
    NativeKeyframeStructureVerdict,
)
from comfyui_h3_context.core.native_source_compatibility import NativeSourceObservation
from comfyui_h3_context.core.production_import import ProductionAutomaticPlanAuthorityV1
from comfyui_h3_context.core.production_workbench import ProductionWorkbenchProjection
from comfyui_h3_context.core.ui_projection import ExecutionCorrelation
from comfyui_h3_context.nodes import (
    H3ContextCompilerNode,
    H3ContextPlanNode,
    H3ContextRequestNode,
    H3ContextValidatorNode,
    H3ReferenceRegistryNode,
)


def _environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mode: str
) -> tuple[
    managed_api.ManagedSequenceService,
    managed_api.ManagedModeQualificationRegistry,
    ManagedModeQualificationV1,
    ProductionWorkspaceRegistry,
    ProductionAutomaticPlanAuthorityV1,
    dict[str, Any],
    SequenceCoordinatorRegistry,
    SidebarWorkspaceRegistry,
    InputGeometryRegistry,
    dict[str, Any],
    dict[str, Any],
    Callable[[], None],
]:
    roles = {
        "i2va": ("first_frame",),
        "l2va": ("last_frame",),
        "fl2va": ("first_frame", "last_frame"),
    }[mode]
    references = H3ReferenceRegistryNode().build_registry(**{role: object() for role in roles})[0]
    request = H3ContextRequestNode().build_request(mode, "A blue sphere turns slowly.", 5.0)[0]
    plan = H3ContextPlanNode().build_plan(request, references)[0]
    _, _, document = H3ContextCompilerNode().compile(plan)
    report = H3ContextValidatorNode().validate(plan, document)[1]
    assert report.validation.is_valid
    assert [(asset.asset_id, asset.role.value) for asset in references.assets] == [
        (role + "_1", role) for role in roles
    ]
    clock = [10.0]
    sidebar = SidebarWorkspaceRegistry(clock=lambda: clock[0])
    source = sidebar.publish(
        report, build_native_h3_wiring(report), ExecutionCorrelation("source", "node")
    )
    production = ProductionWorkspaceRegistry(
        seed_claim=sidebar.claim_production_seed, clock=lambda: clock[0]
    )
    input_root = tmp_path / "input"
    geometry = InputGeometryRegistry(input_root_factory=lambda: input_root, clock=lambda: clock[0])
    monkeypatch.setattr(
        composition_root,
        "_INSTANCES",
        {
            composition_root.SIDEBAR_WORKSPACE: sidebar,
            composition_root.PRODUCTION_WORKSPACE: production,
            composition_root.INPUT_GEOMETRY: geometry,
        },
    )
    created = cast(
        ProductionWorkbenchProjection,
        production.dispatch(
            {
                "schema": "h3.context.production_workbench.action.v1",
                "request_id": "create",
                "action": "create_workspace_from_context",
                "payload": {"context_workspace_handle": source.workspace_id},
            }
        ).projection,
    )
    native_source = replace(
        cast(NativeSourceObservation, observed_source()),
        keyframes=NativeKeyframeStructureVerdict(
            KeyframeStructureReason.ADMITTED, "admitted", PRODUCTION_MANIFEST.fingerprint
        ),
        guide=NativeGuideCapability(True, GUIDE_REQUIRED_INPUTS),
    )
    host = observation()
    _install_loader_inventory(monkeypatch)
    monkeypatch.setattr(comfyui_generation_profile, "observe_host", lambda *_args: host)
    monkeypatch.setattr(
        comfyui_generation_profile,
        "_observe_native_composition",
        lambda: composition_observation(host, native_source),
    )
    planning = composition_root.get(composition_root.PRODUCTION_PLANNING)
    monkeypatch.setattr(planning, "_clock", lambda: clock[0])
    prepare = {
        "workspace_handle": created.workspace_handle,
        "expected_workspace_revision": created.workspace_revision,
        "expected_workspace_fingerprint": created.workspace_fingerprint,
        "context_workspace_handle": source.workspace_id,
        "expected_report_revision": source.report_revision,
        "expected_report_fingerprint": source.report_fingerprint,
        "expected_planning_revision": 0,
        "target_seconds": 20,
        "policy": "fixed_10",
    }
    _, proposal = prepared_proposal(planning, prepare)
    imported = planning.dispatch(
        action(
            "import_plan",
            {**selectors(proposal), "proposal_id": proposal["proposal"]["proposal_id"]},
            "import",
        )
    ).to_wire()
    selection: dict[str, Any] = {
        "workspace_handle": created.workspace_handle,
        "expected_workspace_revision": imported["workspace_revision"],
        "expected_workspace_fingerprint": imported["workspace_fingerprint"],
        "expected_plan_fingerprint": imported["plan_fingerprint"],
    }
    registry = composition_root.get(composition_root.MANAGED_MODE_QUALIFICATION)
    monkeypatch.setattr(registry, "_clock", lambda: clock[0])
    monkeypatch.setattr(registry._producer, "_clock", lambda: clock[0])
    ready = planning.dispatch(action("prepare_managed_readiness", selection, "ready")).to_wire()
    assert ready["status"] == "ready" and "media_bindings" not in ready
    qualification = registry.claim(ready["qualification_fingerprint"])
    authority = production.claim_automatic_plan_authority(
        selection["workspace_handle"],
        **{key: value for key, value in selection.items() if key != "workspace_handle"},
    )
    coordinator = SequenceCoordinatorRegistry(
        production_registry=production,
        output_root_factory=lambda: tmp_path / "output",
        private_root_factory=lambda: tmp_path / "private",
        clock=lambda: clock[0],
    )
    composition_root.install(composition_root.SEQUENCE_COORDINATOR, coordinator)
    service = composition_root.get(composition_root.MANAGED_SEQUENCE)
    monkeypatch.setattr(service, "_clock", lambda: clock[0])
    # IMPORTANT: composition captures the same expiry clock in its retained pool; a late
    # fixture clock replacement must preserve that invariant or every valid binding expires.
    monkeypatch.setattr(service._sequence_media, "_clock", lambda: clock[0])
    monkeypatch.setattr(coordinator._managed, "_clock", lambda: clock[0])
    readers = (
        sidebar,
        production,
        geometry,
        planning,
        registry,
        registry._producer,
        coordinator,
        coordinator._managed,
        service,
        service._sequence_media,
    )

    def assert_shared_clock() -> None:
        assert all(reader._clock() == clock[0] == 10.0 for reader in readers)

    authorized = service.authorize(
        managed_api.AuthorizeManagedSequenceRequestV1(
            request_id="authorize",
            **selection,
            generation_plan_fingerprint=authority.proposal.fingerprint,
            compiler_fingerprint=qualification.baseline.compiler_fingerprint,
            host_capability_fingerprint=qualification.baseline.host_capability_fingerprint,
            explicit_intent="generate_approved_sequence",
        )
    )
    payload: dict[str, Any] = {
        "parent_sequence_id": authorized.parent_sequence_id,
        "expected_revision": authorized.revision,
        "authorization_fingerprint": authorized.authorization_fingerprint,
        "qualification_fingerprint": qualification.fingerprint,
    }
    entries = []
    for index, asset in enumerate(references.assets):
        row = binding_wire(index)
        path = input_root / row["locator"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_png(64, 64))
        row.update(
            asset_id=asset.asset_id,
            role=asset.role.value,
            transform=None,
            source_identity=geometry.observe(_request(row["locator"])).to_wire(),
        )
        row["registry_endpoint"].update(
            input_name=asset.role.value, source_node_id=row["loader_node_id"]
        )
        entries.append(row)
    bindings = {"schema": "h3.context.sequence_media_binding_set.v1", "entries": entries}
    return (
        service,
        registry,
        qualification,
        production,
        authority,
        selection,
        coordinator,
        sidebar,
        geometry,
        payload,
        bindings,
        assert_shared_clock,
    )


def _start(
    service: managed_api.ManagedSequenceService,
    registry: managed_api.ManagedModeQualificationRegistry,
    payload: object,
) -> managed_api.ManagedSequenceMutationResultV1:
    decoded = managed_api.decode_managed_sequence_action_json(
        json.dumps(
            {
                "schema": managed_api.MANAGED_SEQUENCE_ACTION_SCHEMA,
                "request_id": "start",
                "action": "start_sequence",
                "payload": payload,
            }
        ).encode()
    )
    return cast(
        managed_api.ManagedSequenceMutationResultV1,
        managed_api.dispatch_decoded_managed_sequence_action(
            service, decoded, qualification_claimant=registry.claim
        ),
    )


@pytest.mark.parametrize("mode", ["i2va", "l2va", "fl2va"])
@pytest.mark.parametrize("defect", ["missing", "wrong_kind", "wrong_loader", "invalid_receipt"])
def test_real_readiness_start_refuses_before_resources_and_corrected_generate_retries(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mode: str, defect: str
) -> None:
    (
        service,
        registry,
        qualification,
        production,
        authority,
        selection,
        coordinator,
        sidebar,
        geometry,
        payload,
        bindings,
        assert_shared_clock,
    ) = _environment(monkeypatch, tmp_path, mode)
    before = cast(managed_api._ServiceEntry, service._entry).sequence
    before_sidebar = set(sidebar._entries)
    if defect != "missing":
        payload["media_bindings"] = bindings
        if defect == "wrong_kind":
            bindings["entries"][0]["kind"] = "video"
        elif defect == "wrong_loader":
            bindings["entries"][0]["loader_class"] = "LoadVideo"
        else:
            bindings["entries"][0]["source_identity"]["receipt_handle"] = "ig_" + "z" * 40
    expected = {
        "missing": "sequence_media_binding_missing",
        "wrong_kind": "sequence_media_binding_invalid",
        "wrong_loader": "sequence_media_binding_invalid",
        "invalid_receipt": "sequence_media_unavailable",
    }[defect]
    assert_shared_clock()
    with pytest.raises(managed_api.ManagedSequenceServiceError, match=expected):
        _start(service, registry, payload)
    assert cast(managed_api._ServiceEntry, service._entry).sequence is before
    assert not coordinator._managed_start_resources and not coordinator._runs
    assert service._sequence_media.parent_count == 0 and set(sidebar._entries) == before_sidebar
    assert registry.claim(qualification.fingerprint) is qualification
    assert (
        production.claim_automatic_plan_authority(
            selection["workspace_handle"],
            **{key: value for key, value in selection.items() if key != "workspace_handle"},
        )
        is authority
    )
    for entry in bindings["entries"]:
        entry.update(
            kind="image",
            loader_class="LoadImage",
            source_identity=geometry.observe(_request(entry["locator"])).to_wire(),
        )
    payload["media_bindings"] = bindings
    assert_shared_clock()
    started = _start(service, registry, payload)
    assert started.state.value == "active" and len(coordinator._managed_start_resources) == 1
    assert not coordinator._runs and service._sequence_media.parent_count == 1
    assert registry.claim(qualification.fingerprint) is qualification
    assert _start(service, registry, payload).replayed
    assert len(coordinator._managed_start_resources) == 1
    service.cancel(
        managed_api.ManagedSequenceMutationAuthorityV1(
            request_id="cancel",
            parent_sequence_id=started.parent_sequence_id,
            expected_revision=started.revision,
            authorization_fingerprint=started.authorization_fingerprint,
        )
    )
    released = coordinator._managed_start_resources[started.parent_sequence_id]
    assert (
        released.ledger_released
        and released.child_slot_released
        and released.artifact_capacity_released
    )
    assert service._sequence_media.parent_count == 0
