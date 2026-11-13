"""Real managed-child admission keeps the first completed receipt's output canvas."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from test_m23_15_sequence_coordinator import (
    _action,
    _fp,
    _observation,
    _required_response,
)
from test_m26_03_context_materializer import _proposal
from test_m26_04_managed_sequence_service import _qualification
from test_production_import import _request
from test_sequence_media_bindings import binding_wire

import comfyui_h3_context.adapters.comfyui_sequence_coordinator as coordinator_adapter
from comfyui_h3_context.adapters.comfyui_input_geometry import InputGeometryReceipt
from comfyui_h3_context.adapters.comfyui_production_workspace import (
    ProductionWorkbenchError,
    ProductionWorkspaceRegistry,
)
from comfyui_h3_context.adapters.comfyui_sequence_coordinator import (
    RELEASE_REQUEST_V2_SCHEMA,
    ObservedVideoArtifact,
    SequenceCoordinatorError,
    SequenceCoordinatorRegistry,
)
from comfyui_h3_context.adapters.comfyui_sidebar_workspace import SidebarWorkspaceRegistry
from comfyui_h3_context.adapters.managed_sequence_service import (
    AuthorizeManagedSequenceRequestV1,
    BindManagedSequenceChildRequestV1,
    ManagedChildBindingRequestV1,
    ManagedChildCorrelationV1,
    ManagedPreparedContextV2,
    ManagedPreparedGraphObservationV1,
    ManagedSequenceMutationAuthorityV1,
    PrepareManagedSequenceChildRequestV1,
    ReadManagedPreparedContextRequestV1,
    RecordManagedSequenceArtifactRequestV1,
    RecordManagedSequenceSubmissionRequestV1,
    RecordManagedSequenceTerminalRequestV1,
    StartManagedSequenceRequestV1,
    build_managed_sequence_service,
)
from comfyui_h3_context.adapters.production_context_materializer import (
    CanonicalProductionMaterializer,
)
from comfyui_h3_context.adapters.production_planning_source import ProductionPlanningSourceSnapshot
from comfyui_h3_context.adapters.sequence_media_bindings import SequenceMediaBindingSetV1
from comfyui_h3_context.context_pipeline_nodes import (
    H3ContextCompilerNode,
    H3ContextPlanNode,
    H3ContextValidatorNode,
)
from comfyui_h3_context.core import ExecutionCorrelation
from comfyui_h3_context.core.constraints import HardConstraintSet
from comfyui_h3_context.core.contracts import AssetRole, MediaKind, TaskMode
from comfyui_h3_context.core.evidence import EvidenceSet
from comfyui_h3_context.core.intent_graph import IntentGraph
from comfyui_h3_context.core.native_h3 import build_native_h3_wiring
from comfyui_h3_context.core.normalization import RawContextRequest
from comfyui_h3_context.core.production_workbench import ProductionWorkbenchProjection
from comfyui_h3_context.core.registry import ReferenceAsset, build_reference_registry
from comfyui_h3_context.core.segment_artifacts import begin_segment_artifact_receipt
from comfyui_h3_context.core.segment_workspace import derive_segment_manifests


def canvas_bindings(source: Any, cropped: bool) -> Any:
    entries = []
    for index, asset in enumerate(source.report.request.reference_registry.assets):
        row = binding_wire(index)
        row["asset_id"], row["role"] = asset.asset_id, asset.role.value
        row["registry_endpoint"]["input_name"] = asset.role.value
        if not cropped:
            row["transform"] = None
            row["registry_endpoint"]["source_node_id"] = row["loader_node_id"]
        entries.append(row)
    return (
        SequenceMediaBindingSetV1.from_wire(
            {"schema": "h3.context.sequence_media_binding_set.v1", "entries": entries}
        )
        if entries
        else None
    )


def canvas_observation(bindings: Any, *, frame_parent: bool = False) -> dict[str, Any]:
    wire = _observation()
    if frame_parent:
        wire.pop("source_identity")
        wire.update(
            schema="h3.context.prepared_graph_observation.v5",
            source_identities=[
                dict(
                    asset_id=row.asset_id,
                    role=row.role.value,
                    receipt_handle=row.source_identity.receipt_handle,
                    source_fingerprint=row.source_identity.source_fingerprint,
                )
                for row in (() if bindings is None else bindings.entries)
            ],
            media_binding_fingerprint=None if bindings is None else bindings.fingerprint,
        )
    return wire


def canvas_source(
    sidebar: SidebarWorkspaceRegistry,
    *,
    mode: TaskMode = TaskMode.T2VA,
    constraints: HardConstraintSet | None = None,
    evidence: EvidenceSet | None = None,
    user_intent: str = "A subject crosses the scene.",
    graph: IntentGraph | None = None,
) -> ProductionPlanningSourceSnapshot:
    constraints = HardConstraintSet() if constraints is None else constraints
    evidence = EvidenceSet.empty() if evidence is None else evidence
    roles = {
        TaskMode.T2VA: (),
        TaskMode.I2VA: (AssetRole.FIRST_FRAME,),
        TaskMode.L2VA: (AssetRole.LAST_FRAME,),
        TaskMode.FL2VA: (AssetRole.FIRST_FRAME, AssetRole.LAST_FRAME),
    }[mode]
    registry = build_reference_registry(
        tuple(
            ReferenceAsset(f"canvas_asset_{index}", MediaKind.IMAGE, role, index + 1)
            for index, role in enumerate(roles)
        )
    )
    request = RawContextRequest(
        mode=mode,
        user_intent=user_intent,
        duration_seconds=8,
        assets=registry.to_asset_descriptors(),
        hard_constraints=constraints,
        reference_registry=registry,
        evidence=evidence,
    )
    plan = H3ContextPlanNode().build_plan(request, registry, graph)[0]
    document = H3ContextCompilerNode().compile(plan)[2]
    report = H3ContextValidatorNode().validate(plan, document)[1]
    projection = sidebar.publish(
        report,
        build_native_h3_wiring(report),
        ExecutionCorrelation("prompt.source", "node.source"),
    )
    return sidebar.snapshot_production_planning_source(
        projection.workspace_id,
        expected_report_revision=projection.report_revision,
        expected_report_fingerprint=projection.report_fingerprint,
    )


class _CanvasBridge:
    """Real registries and stores; only host execution and codec inspection are external doubles."""

    def __init__(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: TaskMode, cropped: bool = False
    ) -> None:
        self.sidebar = SidebarWorkspaceRegistry(max_entries=4, ttl_seconds=60)
        source = canvas_source(self.sidebar, mode=mode)
        self.mode = mode
        self.bindings = canvas_bindings(source, cropped)
        self.shape = (362, 640, 640, 3)
        context, proposal = _proposal(source, parts=(10, 6))
        self.production = ProductionWorkspaceRegistry(seed_claim=self.sidebar.claim_production_seed)
        created = self.production.dispatch(
            {
                "schema": "h3.context.production_workbench.action.v1",
                "request_id": "bridge.create",
                "action": "create_workspace_from_context",
                "payload": {"context_workspace_handle": source.workspace_id},
            }
        ).projection
        assert isinstance(created, ProductionWorkbenchProjection)
        self.context_releases: list[str] = []
        released = self.context_releases

        class TrackedMaterializer(CanonicalProductionMaterializer):
            def _release(self, workspace_id: str, **expected: Any) -> None:
                super()._release(workspace_id, **expected)
                released.append(workspace_id)

        materialize = TrackedMaterializer(source, workspace_registry=self.sidebar)

        imported = self.production.import_automatic_plan(
            _request(created, context, proposal),
            planning_context=context,
            proposal=proposal,
            materialize=materialize,
        ).projection
        self.handle = created.workspace_handle
        self.original = self.production.claim_automatic_plan_authority(
            self.handle,
            expected_workspace_revision=imported.workspace_revision,
            expected_workspace_fingerprint=imported.workspace_fingerprint,
            expected_plan_fingerprint=imported.plan_fingerprint,
        )
        self.manifests = derive_segment_manifests(self.original.workspace)
        self.output = tmp_path / "output"
        self.output.mkdir()
        self.now = [100.0]
        self.coordinator = SequenceCoordinatorRegistry(
            production_registry=self.production,
            output_root_factory=lambda: self.output,
            sequence_media_claimant=lambda value, **_kwargs: InputGeometryReceipt.from_wire(value),
            private_root_factory=lambda: tmp_path / "private",
            artifact_inspector=lambda _body, **_expected: ObservedVideoArtifact("mp4", self.shape),
            clock=lambda: self.now[0],
            clock_ms=lambda: round(self.now[0] * 1000),
        )
        monkeypatch.setattr(
            "comfyui_h3_context.adapters.comfyui_media_preview.ensure_media_preview_route_registered",
            lambda: False,
        )
        self.service = build_managed_sequence_service(
            production_registry=self.production,
            coordinator=self.coordinator,
        )
        self.binding_failures: list[str] = []
        real_bind = self.service._bind_child
        assert real_bind is not None

        def observed_bind(request: ManagedChildBindingRequestV1) -> Any:
            try:
                return real_bind(request)
            except Exception as error:
                self.binding_failures.append(getattr(error, "code", type(error).__name__))
                raise

        self.service._bind_child = observed_bind
        self.service._media_source_claimant = lambda value, **_kwargs: (
            InputGeometryReceipt.from_wire(value)
        )
        self.service._clock = lambda: self.now[0]
        self.service._sequence_media._clock = lambda: self.now[0]
        self.service._epoch_clock_ms = lambda: round(self.now[0] * 1000)
        self.authorized = self.service.authorize(
            AuthorizeManagedSequenceRequestV1(
                request_id="bridge.authorize",
                workspace_handle=self.handle,
                expected_workspace_revision=imported.workspace_revision,
                expected_workspace_fingerprint=imported.workspace_fingerprint,
                expected_plan_fingerprint=imported.plan_fingerprint,
                generation_plan_fingerprint=_fp("bridge.generation"),
                compiler_fingerprint=_fp("bridge.compiler"),
                host_capability_fingerprint=self.original.materialization_receipts[
                    0
                ].capability_fingerprint,
                explicit_intent="generate_approved_sequence",
            )
        )
        assert self.service._entry is not None
        self.parent = self.service.start(
            StartManagedSequenceRequestV1(
                request_id="bridge.start",
                media_bindings=self.bindings,
                parent_sequence_id=self.authorized.parent_sequence_id,
                expected_revision=self.authorized.revision,
                authorization_fingerprint=self.authorized.authorization_fingerprint,
            ),
            qualification=_qualification(self.service._entry.sequence.authorization),
        )
        self.receipts: list[Any] = []
        self.states: list[Any] = []
        self.last_terminal: Any = None
        self.last_artifact_request: dict[str, Any] = {}

    def mutation(self, request_id: str) -> ManagedSequenceMutationAuthorityV1:
        return ManagedSequenceMutationAuthorityV1(
            request_id=request_id,
            parent_sequence_id=self.parent.parent_sequence_id,
            expected_revision=self.parent.revision,
            authorization_fingerprint=self.parent.authorization_fingerprint,
        )

    def read(self) -> Any:
        result = self.production.dispatch(
            {
                "schema": "h3.context.production_workbench.action.v1",
                "request_id": f"bridge.read.{self.parent.revision}",
                "action": "read_projection",
                "payload": {"workspace_handle": self.handle},
            }
        )
        assert result.projection is not None
        return result.projection

    def complete_child(
        self, index: int, *, publish_terminal: bool = True, artifact_byte_delta: int = 0
    ) -> None:
        segment_id = self.manifests[index].segment_id
        self.shape = (self.manifests[index].duration.frame_count, *self.shape[1:])
        previous = None if index == 0 else self.last_terminal.terminal_fingerprint
        prepared = self.service.prepare_child(
            PrepareManagedSequenceChildRequestV1(
                request_id=f"bridge.prepare.{index}",
                parent_sequence_id=self.parent.parent_sequence_id,
                expected_revision=self.parent.revision,
                authorization_fingerprint=self.parent.authorization_fingerprint,
                segment_id=segment_id,
                predecessor_terminal_fingerprint=previous,
            )
        )
        assert prepared.execution is not None
        assert prepared.context_workspace_handle is not None
        context = self.service.read_prepared_child_context(
            ReadManagedPreparedContextRequestV1(
                request_id=f"bridge.context.{index}",
                parent_sequence_id=prepared.parent_sequence_id,
                expected_revision=prepared.revision,
                authorization_fingerprint=prepared.authorization_fingerprint,
                segment_id=segment_id,
                eligible_execution_fingerprint=prepared.execution.fingerprint,
                materialization_receipt_fingerprint=prepared.execution.materialization_receipt_fingerprint,
                context_workspace_handle=prepared.context_workspace_handle,
            )
        )
        frame_parent = isinstance(context, ManagedPreparedContextV2)
        assert frame_parent == (self.mode is not TaskMode.T2VA)
        observation = ManagedPreparedGraphObservationV1.from_wire(
            {
                **canvas_observation(
                    context.media_bindings
                    if isinstance(context, ManagedPreparedContextV2)
                    else None,
                    frame_parent=frame_parent,
                ),
                "expected_frames": self.shape[0],
                "graph_fingerprint": _fp(f"bridge.graph.{index}"),
                "compiled_prompt_fingerprint": _fp(f"bridge.prompt.{index}"),
                "owned_projection_fingerprint": _fp(f"bridge.owned.{index}"),
            }
        )
        bound = self.service.bind_child(
            BindManagedSequenceChildRequestV1(
                request_id=f"bridge.bind.{index}",
                parent_sequence_id=prepared.parent_sequence_id,
                expected_revision=prepared.revision,
                authorization_fingerprint=prepared.authorization_fingerprint,
                segment_id=segment_id,
                eligible_execution_fingerprint=prepared.execution.fingerprint,
                materialization_receipt_fingerprint=self.original.materialization_receipts[
                    index
                ].fingerprint,
                graph_fingerprint=observation.graph_fingerprint,
                compiled_prompt_fingerprint=observation.compiled_prompt_fingerprint,
                owned_projection_fingerprint=observation.owned_projection_fingerprint,
                previous_owned_projection_fingerprint=_fp(f"bridge.owned.{index - 1}"),
                active_workflow_fingerprint=_fp("bridge.workflow"),
                correlation=ManagedChildCorrelationV1(
                    pending_correlation_id=f"managed.pending.bridge.{index}",
                    execution_node_id="node.shell",
                ),
                observation=observation,
            )
        )
        assert bound.child_authority is not None, self.binding_failures
        self.parent = bound
        child = _required_response(
            self.coordinator.dispatch(
                _action(
                    f"bridge.child.read.{index}",
                    "read_sequence",
                    {"run_handle": bound.child_authority.run_handle},
                )
            )
        )
        command = child.sequence.eligible_commands[0]
        prompt_id = f"prompt.bridge.{index}"
        submitted = _required_response(
            self.coordinator.dispatch(
                _action(
                    f"bridge.submit.{index}",
                    "record_submission",
                    {
                        "run_handle": child.run_handle,
                        "expected_state_fingerprint": child.sequence.state.fingerprint,
                        "job_id": command.job_id,
                        "transaction_id": command.transaction_id,
                        "graph_fingerprint": command.job.graph_fingerprint,
                        "compiled_prompt_fingerprint": command.job.compiled_prompt_fingerprint,
                        "queue_prompt_id": prompt_id,
                    },
                )
            )
        )
        self.parent = self.service.record_submission(
            RecordManagedSequenceSubmissionRequestV1(
                authority=self.mutation(f"bridge.parent.submit.{index}"),
                segment_id=segment_id,
                child_run_handle=child.run_handle,
                child_state_fingerprint=submitted.sequence.state.fingerprint,
                queue_prompt_id=prompt_id,
                timeout_ms=60000,
                active_workflow_fingerprint=_fp("bridge.workflow"),
                previous_owned_projection_fingerprint=_fp(f"bridge.owned.{index - 1}"),
                written_owned_projection_fingerprint=observation.owned_projection_fingerprint,
            )
        )
        media = self.output / f"child-{index}.mp4"
        payload = f"synthetic-encoded-child-{index}".encode()
        media.write_bytes(payload)
        self.last_artifact_request = {
            "run_handle": child.run_handle,
            "expected_state_fingerprint": submitted.sequence.state.fingerprint,
            "queue_prompt_id": prompt_id,
            "output_node_id": "node.save.video",
            "locator": {"filename": media.name, "subfolder": "", "type": "output"},
        }
        captured = _required_response(
            self.coordinator.dispatch(
                _action(
                    f"bridge.capture.{index}",
                    "record_artifact",
                    self.last_artifact_request,
                )
            )
        )
        completed = _required_response(
            self.coordinator.dispatch(
                _action(
                    f"bridge.terminal.{index}",
                    "record_terminal",
                    {
                        "run_handle": child.run_handle,
                        "expected_state_fingerprint": captured.sequence.state.fingerprint,
                        "queue_prompt_id": prompt_id,
                        "kind": "success",
                    },
                )
            )
        )
        assert completed.artifact_authority is not None
        assert completed.terminal_fingerprint is not None
        entry = self.coordinator._entry(child.run_handle)
        receipt = entry.artifact_receipt
        assert receipt is not None
        assert entry.workspace is self.original.workspace
        assert receipt.manifest_fingerprint == self.manifests[index].fingerprint
        self.receipts.append(receipt)
        self.states.append(entry.state)
        self.parent = self.service.record_artifact(
            RecordManagedSequenceArtifactRequestV1(
                authority=self.mutation(f"bridge.parent.artifact.{index}"),
                segment_id=segment_id,
                queue_prompt_id=prompt_id,
                artifact_receipt_fingerprint=receipt.fingerprint,
                artifact_bytes=len(payload) + artifact_byte_delta,
            )
        )
        self.coordinator.dispatch(
            _action(
                f"bridge.release.{index}",
                "release_sequence",
                {
                    "schema": RELEASE_REQUEST_V2_SCHEMA,
                    "run_handle": child.run_handle,
                    "intent": "cleanup_terminal",
                    "expected_state_fingerprint": completed.sequence.state.fingerprint,
                    "observed_terminal_fingerprint": completed.terminal_fingerprint,
                },
            )
        )
        assert child.run_handle not in self.coordinator._runs
        assert (
            self.production.claim_workspace_authority(
                self.handle,
                expected_workspace_revision=self.original.workspace.revision,
                expected_workspace_fingerprint=self.original.workspace.fingerprint,
            )
            is self.original.workspace
        )
        self.last_terminal = RecordManagedSequenceTerminalRequestV1(
            authority=self.mutation(f"bridge.parent.terminal.{index}"),
            segment_id=segment_id,
            queue_prompt_id=prompt_id,
            kind="success",
            terminal_fingerprint=completed.terminal_fingerprint,
        )
        if publish_terminal:
            self.parent = self.service.record_terminal(self.last_terminal)


@pytest.mark.parametrize("mode", (TaskMode.T2VA, TaskMode.I2VA, TaskMode.L2VA, TaskMode.FL2VA))
@pytest.mark.parametrize("dimensions", ((480, 640), (640, 864), (480, 864)))
def test_managed_sequence_rejects_different_child_canvas(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: TaskMode, dimensions: tuple[int, int]
) -> None:
    bridge = _CanvasBridge(tmp_path, monkeypatch, mode)
    bridge.complete_child(0)
    first = bridge.receipts[0]
    store = bridge.coordinator._store()
    calls: list[str] = []
    begin_receipt = begin_segment_artifact_receipt

    def observe_receipt(*args: Any, **kwargs: Any) -> Any:
        calls.append("receipt_begin")
        return begin_receipt(*args, **kwargs)

    monkeypatch.setattr(coordinator_adapter, "begin_segment_artifact_receipt", observe_receipt)
    for name in ("begin", "commit"):
        original = getattr(store, name)

        def observe(*args: Any, _name: str = name, _original: Any = original, **kwargs: Any) -> Any:
            calls.append(_name)
            return _original(*args, **kwargs)

        monkeypatch.setattr(store, name, observe)
    bridge.shape = (362, *dimensions, 3)
    with pytest.raises(SequenceCoordinatorError, match="artifact_shape_mismatch") as failure:
        bridge.complete_child(1)
    assert failure.value.status == 422
    assert failure.value.category == "artifact_content_invalid"
    assert calls == []
    entry = next(iter(bridge.coordinator._runs.values()))
    assert entry.state.runtimes[0].state.value == "output_verification_failed"
    assert entry.artifact_receipt is None and entry.artifact_preview_source is None
    assert bridge.read().outputs == ()
    assert bridge.parent.state.value != "succeeded"
    assert bridge.service._entry is not None
    assert bridge.service._entry.sequence.active_segment_id == bridge.manifests[1].segment_id
    resource = bridge.coordinator._managed_resource_for_child(entry.run_handle)
    assert resource is not None
    assert resource.completed_children[bridge.manifests[0].segment_id].receipt is first
    assert len(resource.completed_children) == 1


@pytest.mark.parametrize("mode", (TaskMode.T2VA, TaskMode.I2VA, TaskMode.L2VA, TaskMode.FL2VA))
@pytest.mark.parametrize("cropped", (False, True))
def test_equal_child_canvas_accepts_retained_geometry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: TaskMode, cropped: bool
) -> None:
    bridge = _CanvasBridge(tmp_path, monkeypatch, mode, cropped)
    bridge.complete_child(0)
    bridge.complete_child(1)
    assert bridge.parent.state.value == "succeeded"
    assert [row.shape[1:3] for row in bridge.receipts] == [(640, 640), (640, 640)]
    assert bridge.receipts[0].shape[0] != bridge.receipts[1].shape[0]


@pytest.mark.parametrize("mismatched_candidate", (False, True))
def test_committed_managed_candidate_rechecks_first_canvas_without_decode_or_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mismatched_candidate: bool
) -> None:
    bridge = _CanvasBridge(tmp_path, monkeypatch, TaskMode.FL2VA)
    bridge.complete_child(0)
    first = bridge.receipts[0]
    real_project = bridge.production.project_managed_child_generation
    publications: list[Any] = []

    def transient_publish(*args: Any, **kwargs: Any) -> Any:
        receipt = args[3] if len(args) > 3 else kwargs.get("receipt")
        if receipt is not None:
            publications.append(receipt)
            if len(publications) == 1:
                raise ProductionWorkbenchError("workspace_busy", 423)
        return real_project(*args, **kwargs)

    monkeypatch.setattr(bridge.production, "project_managed_child_generation", transient_publish)
    with pytest.raises(SequenceCoordinatorError, match="workspace_busy") as first_error:
        bridge.complete_child(1)
    assert first_error.value.retry_disposition == "retry_output_verification"
    entry = next(iter(bridge.coordinator._runs.values()))
    candidate = entry.artifact_candidate
    assert candidate is not None and candidate.completed_receipt is not None
    committed = candidate.completed_receipt
    assert committed.shape[1:3] == first.shape[1:3]
    if mismatched_candidate:
        # An old committed candidate must be checked against the original first receipt,
        # even though this retry intentionally bypasses codec inspection and storage.
        candidate.completed_receipt = replace(
            committed, shape=(committed.shape[0], 480, 864, 3), receipt_fingerprint=None
        )
    forbidden: list[str] = []

    def reject_io(*_args: Any, **_kwargs: Any) -> Any:
        forbidden.append("decode_or_store")
        raise AssertionError("committed retry must not decode or store")

    monkeypatch.setattr(bridge.coordinator, "_artifact_inspector", reject_io)
    store = bridge.coordinator._store()
    monkeypatch.setattr(store, "begin", reject_io)
    monkeypatch.setattr(store, "commit", reject_io)
    action = _action("bridge.retry.committed", "record_artifact", bridge.last_artifact_request)
    if mismatched_candidate:
        monkeypatch.setattr(bridge.production, "prepare_generated_preview_sources", reject_io)
        with pytest.raises(SequenceCoordinatorError, match="artifact_shape_mismatch") as failure:
            bridge.coordinator.dispatch(action)
        assert failure.value.status == 422
        assert failure.value.category == "artifact_content_invalid"
        assert entry.artifact_receipt is None
        assert len(publications) == 1
        assert bridge.read().outputs == ()
    else:
        result = _required_response(bridge.coordinator.dispatch(action))
        assert result.disposition == "artifact_verified"
        assert entry.artifact_receipt is committed
        assert len(publications) == 2
    assert forbidden == []
    resource = bridge.coordinator._managed_resource_for_child(entry.run_handle)
    assert resource is not None
    assert resource.completed_children[bridge.manifests[0].segment_id].receipt is first
