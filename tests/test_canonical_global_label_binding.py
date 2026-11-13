"""Authored global labels bind through canonical admission without weakening conflicts."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest
from test_m26_08_reference_bearing_planning import (
    SINGLE,
    Source,
    _action,
    _selectors,
    materialized,
    rows_at,
    source,
)

from comfyui_h3_context.adapters.comfyui_production_workspace import (
    PRODUCTION_ACTION_SCHEMA,
    ProductionWorkspaceRegistry,
)
from comfyui_h3_context.adapters.comfyui_sidebar_workspace import SidebarWorkspaceRegistry
from comfyui_h3_context.adapters.production_planning_service import ProductionPlanningService
from comfyui_h3_context.adapters.production_planning_source import build_production_planning_context
from comfyui_h3_context.core import IntentSubject, TimelineSegment, TimePoint, build_intent_graph
from comfyui_h3_context.core.contracts import TaskMode
from comfyui_h3_context.core.native_h3 import build_native_h3_wiring
from comfyui_h3_context.core.production_duration import (
    ProductionDurationIntentV1,
    SegmentationPolicyV1,
)
from comfyui_h3_context.core.production_storyboard import (
    ProductionPlanningContextV2,
    ProductionStoryboardAdmissionRequestV1,
    ProductionStoryboardAdmissionService,
    ProductionStoryboardAdmissionV1,
    ProductionStoryboardAdmissionV2,
    SegmentationProposalRefusalCodeV1,
    SegmentationProposalRefusalV1,
    SegmentationProposalV2,
    StoryboardAdmissionRefusalCodeV1,
    StoryboardAdmissionRefusalV1,
    StoryboardShotV1,
    StoryboardSourceKindV1,
    build_segmentation_proposal,
)
from comfyui_h3_context.core.production_workbench import ProductionWorkbenchProjection
from comfyui_h3_context.core.sidebar_workspace import SidebarWorkspaceProjection
from comfyui_h3_context.core.ui_projection import ExecutionCorrelation
from comfyui_h3_context.core.validation_lifecycle import ValidatedReportEnvelope
from comfyui_h3_context.nodes import (
    H3ContextCompilerNode,
    H3ContextPlanNode,
    H3ContextRequestNode,
    H3ContextValidatorNode,
    H3ReferenceRegistryNode,
)


def _subject_source(
    *,
    frame: bool,
    subject_asset: str,
    explicit_subjects: bool = False,
    subjects: tuple[IntentSubject, ...] | None = None,
) -> Source:
    request = H3ContextRequestNode().build_request(TaskMode.REF2VA, SINGLE, duration_seconds=10)[0]
    registry = H3ReferenceRegistryNode().build_registry(
        images=[object()], first_frame=object() if frame else None
    )[0]
    initial = H3ContextPlanNode().build_plan(request, registry)[0]
    duration = TimePoint.from_text(str(initial.request.effective_duration_seconds))
    declared = (
        subjects
        if subjects is not None
        else (IntentSubject("subject_sphere", "the sphere", (subject_asset,)),)
    )
    graph = build_intent_graph(
        effective_duration=duration,
        registry=registry,
        subjects=declared,
        segments=(
            TimelineSegment(
                "segment_1",
                TimePoint.from_text("0"),
                duration,
                subject_ids=tuple(row.subject_id for row in declared) if explicit_subjects else (),
            ),
        ),
    )
    assert graph.graph is not None, "real_subject_graph"
    plan = H3ContextPlanNode().build_plan(request, registry, graph.graph)[0]
    document = H3ContextCompilerNode().compile(plan)[2]
    report = H3ContextValidatorNode().validate(plan, document)[1]
    assert report.validation.is_valid, "real_subject_report"
    sidebar = SidebarWorkspaceRegistry(max_entries=8, ttl_seconds=600)
    projection = sidebar.publish(
        report,
        build_native_h3_wiring(report),
        ExecutionCorrelation("prompt.labels", "node.labels"),
    )
    snapshot = sidebar.snapshot_production_planning_source(
        projection.workspace_id,
        expected_report_revision=projection.report_revision,
        expected_report_fingerprint=projection.report_fingerprint,
    )
    return Source(sidebar, snapshot, report)


def _authored_field_source(origin: Source, heading: str, field: str) -> Source:
    """Use the real stage/validate/snapshot route; do not fabricate semantic authority."""
    snapshot = origin.snapshot
    original = next(
        section.body
        for section in origin.report.prompt_document.sections
        if section.heading == heading
    )
    staged = origin.sidebar.dispatch(
        {
            "schema": "h3.context.sidebar.action.v2",
            "workspace_id": snapshot.workspace_id,
            "expected_revision": snapshot.report_revision,
            "expected_report_fingerprint": snapshot.report_fingerprint,
            "action": "stage_prompt",
            "payload": {
                "reason": "Specify the scene",
                "prompt_text": origin.report.prompt_document.text.replace(
                    heading + ": " + original, heading + ": " + field, 1
                ),
            },
        }
    )
    assert isinstance(staged, SidebarWorkspaceProjection), "author_edit_stage"
    validated = origin.sidebar.dispatch(
        {
            "schema": "h3.context.sidebar.action.v2",
            "workspace_id": staged.workspace_id,
            "expected_revision": staged.report_revision,
            "expected_report_fingerprint": staged.report_fingerprint,
            "action": "validate",
            "payload": {},
        }
    )
    assert isinstance(validated, SidebarWorkspaceProjection), "author_edit_validate"
    assert validated.validation_status == "passed", "author_edit_valid"
    snapshot = origin.sidebar.snapshot_production_planning_source(
        validated.workspace_id,
        expected_report_revision=validated.report_revision,
        expected_report_fingerprint=validated.report_fingerprint,
    )
    retained = next(
        section.body
        for section in snapshot.report.prompt_document.sections
        if section.heading == heading
    )
    assert retained == field, "snapshot_keeps_author_edit"
    return Source(origin.sidebar, snapshot, snapshot.report)


def _context(origin: Source, *, target: int = 20) -> ProductionPlanningContextV2:
    return build_production_planning_context(
        origin.snapshot,
        planning_context_id="planning.labels",
        revision=1,
        duration_intent=ProductionDurationIntentV1(
            target_seconds=target, policy=SegmentationPolicyV1.FIXED_10
        ),
    )


def _admission(
    origin: Source, context: ProductionPlanningContextV2, *, canonical: bool
) -> ProductionStoryboardAdmissionV1 | StoryboardAdmissionRefusalV1:
    return ProductionStoryboardAdmissionService().admit(
        context,
        ProductionStoryboardAdmissionRequestV1(
            request_id="request.labels",
            planning_context_id=context.planning_context_id,
            planning_context_revision=context.revision,
            planning_context_fingerprint=context.fingerprint,
            optimized_candidate_id=context.optimized_candidate_id,
            optimized_candidate_text_fingerprint=context.optimized_candidate_text_fingerprint,
            production_duration_intent_fingerprint=context.duration_intent_fingerprint,
            source_kind=StoryboardSourceKindV1.CANONICAL_OPTIMIZED_PROMPT
            if canonical
            else StoryboardSourceKindV1.USER_REVIEWED_TYPED_ROWS,
            candidate_text=origin.report.prompt_document.text if canonical else None,
            typed_rows=()
            if canonical
            else _reviewed_rows(context.production_duration_intent.target_seconds),
            user_reviewed=not canonical,
        ),
    )


def _reviewed_rows(target: int) -> tuple[StoryboardShotV1, ...]:
    return rows_at((10,), 20) if target == 20 else rows_at((), 10)


def _import_receipts(origin: Source, *, canonical: bool, target: int = 20) -> int:
    production = ProductionWorkspaceRegistry(seed_claim=origin.sidebar.claim_production_seed)
    created = production.dispatch(
        {
            "schema": PRODUCTION_ACTION_SCHEMA,
            "request_id": "labels.create",
            "action": "create_workspace_from_context",
            "payload": {"context_workspace_handle": origin.snapshot.workspace_id},
        }
    ).projection
    assert isinstance(created, ProductionWorkbenchProjection)
    service = ProductionPlanningService(
        sidebar_registry=origin.sidebar, production_registry=production
    )
    prepared = service.dispatch(
        _action(
            "prepare_context",
            {
                "workspace_handle": created.workspace_handle,
                "expected_workspace_revision": created.workspace_revision,
                "expected_workspace_fingerprint": created.workspace_fingerprint,
                "context_workspace_handle": origin.snapshot.workspace_id,
                "expected_report_revision": origin.snapshot.report_revision,
                "expected_report_fingerprint": origin.snapshot.report_fingerprint,
                "expected_planning_revision": 0,
                "target_seconds": target,
                "policy": "fixed_10",
            },
            "labels.prepare",
        )
    ).to_wire()
    admitted = service.dispatch(
        _action(
            "admit_storyboard",
            {
                **_selectors(prepared),
                "source_kind": "canonical_optimized_prompt"
                if canonical
                else "user_reviewed_typed_rows",
                "typed_rows": []
                if canonical
                else [row.to_wire() for row in _reviewed_rows(target)],
                "user_reviewed": not canonical,
            },
            "labels.admit",
        )
    ).to_wire()
    proposed = service.dispatch(
        _action(
            "propose",
            {**_selectors(admitted), "admission_id": admitted["admission_id"]},
            "labels.propose",
        )
    ).to_wire()
    proposal_wire = proposed["proposal"]
    assert isinstance(proposal_wire, dict)
    assert proposal_wire["importable"] is True
    imported = service.dispatch(
        _action(
            "import_plan",
            {**_selectors(proposed), "proposal_id": proposal_wire["proposal_id"]},
            "labels.import",
        )
    ).to_wire()
    fingerprints = imported["materialization_receipt_fingerprints"]
    assert isinstance(fingerprints, list)
    return len(fingerprints)


def _case(case: str, *, explicit_subjects: bool = False) -> tuple[Source, str, str, bool, bool]:
    frame = case in {"ordinary_with_frame", "mixed_frame_subject"}
    subject = case in {"ordinary_subject", "mixed_frame_subject"}
    if subject:
        origin = _subject_source(
            frame=frame, subject_asset="image_1", explicit_subjects=explicit_subjects
        )
    else:
        references: dict[str, Any] = {"images": [object()]}
        if frame:
            references["first_frame"] = object()
        origin = source(TaskMode.REF2VA, SINGLE, 10, **references)
    heading = "overall_soundscape" if case == "ordinary_soundscape" else "summary"
    field = {
        "ordinary_image": "The room follows the style of <Picture 1>.",
        "ordinary_with_frame": "The room follows the style of <Picture 2>.",
        "ordinary_subject": "Keep <Subject 1> in the quiet room.",
        "mixed_frame_subject": (
            "Use the composition of <Picture 1> and keep <Subject 1> in the room."
        ),
        "ordinary_soundscape": "Room ambience follows the setting shown in <Picture 1>.",
    }[case]
    return _authored_field_source(origin, heading, field), heading, field, frame, subject


@pytest.mark.parametrize(
    "case",
    (
        "ordinary_image",
        "ordinary_with_frame",
        "ordinary_subject",
        "mixed_frame_subject",
        "ordinary_soundscape",
    ),
)
@pytest.mark.parametrize("canonical", (True, False), ids=("canonical", "reviewed"))
def test_authored_global_labels_admit_preserve_and_import(case: str, canonical: bool) -> None:
    origin, heading, field, frame, subject = _case(case)
    context = _context(origin)
    admitted = _admission(origin, context, canonical=canonical)
    assert isinstance(admitted, ProductionStoryboardAdmissionV2), getattr(admitted, "code", None)
    bound = next(
        item for item in admitted.semantic_authority.global_fields if item.heading == heading
    )
    assert bound.text == field
    assert bound.subject_ids == (("subject_sphere",) if subject else ())
    assert (
        bound.asset_ids
        == {
            "ordinary_image": ("image_1",),
            "ordinary_with_frame": ("image_1",),
            "ordinary_subject": (),
            "mixed_frame_subject": ("first_frame_1",),
            "ordinary_soundscape": ("image_1",),
        }[case]
    )
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalV2), getattr(proposal, "code", None)
    assert proposal.importable
    assert proposal.blocker_codes == ()
    assert tuple(item.asset_ids for item in proposal.segments) == (
        (("first_frame_1", "image_1"), ("image_1",)) if frame else (("image_1",), ("image_1",))
    )
    for index, sliced in enumerate(proposal.semantic_slices):
        local = next(item for item in sliced.global_fields if item.heading == heading)
        assert local.text == field
        assert local.subject_ids == bound.subject_ids
        assert local.asset_ids == (
            () if case == "mixed_frame_subject" and index == 1 else bound.asset_ids
        )
        assert tuple(item.subject_id for item in sliced.subject_definitions) == (
            ("subject_sphere",) if subject else ()
        )
    if case == "mixed_frame_subject":
        assert (
            "composition of the opening frame of the full video"
            in proposal.segments[1].local_prompt
        )
        assert "<Subject 1>" in proposal.segments[1].local_prompt
    if case == "ordinary_with_frame":
        assert "style of <Picture 1>" in proposal.segments[1].local_prompt
    reports = materialized(origin, context, proposal)
    assert len(reports) == 2
    assert all(report.validation.is_valid for report in reports)
    assert _import_receipts(origin, canonical=canonical) == 2


@pytest.mark.parametrize("canonical", (True, False), ids=("canonical", "reviewed"))
def test_frame_sourced_global_subject_still_fails_strict_census(canonical: bool) -> None:
    origin = _subject_source(frame=True, subject_asset="first_frame_1")
    origin = _authored_field_source(origin, "summary", "Keep <Subject 1> in the quiet room.")
    context = _context(origin)
    admitted = _admission(origin, context, canonical=canonical)
    assert isinstance(admitted, ProductionStoryboardAdmissionV2), getattr(admitted, "code", None)
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalRefusalV1)
    assert proposal.code is SegmentationProposalRefusalCodeV1.STORYBOARD_COVERAGE_INVALID


@pytest.mark.parametrize("case", ("ordinary_image", "ordinary_subject"))
def test_canonical_and_reviewed_paths_keep_the_same_proposal_shape(case: str) -> None:
    origin, _, _, _, _ = _case(case)
    context = _context(origin)
    shapes = []
    for canonical in (True, False):
        admitted = _admission(origin, context, canonical=canonical)
        assert isinstance(admitted, ProductionStoryboardAdmissionV2), getattr(
            admitted, "code", None
        )
        proposal = build_segmentation_proposal(context, admitted)
        assert isinstance(proposal, SegmentationProposalV2)
        shapes.append(
            (
                proposal.importable,
                proposal.blocker_codes,
                tuple(
                    (item.task_mode, item.duration.requested_seconds, item.asset_ids)
                    for item in proposal.segments
                ),
                tuple(
                    (item.global_fields, item.subject_definitions, item.reference_definitions)
                    for item in proposal.semantic_slices
                ),
            )
        )
    assert shapes[0] == shapes[1]


@pytest.mark.parametrize("conflict", ("text", "extra_binding"))
def test_ordinary_label_genuine_equal_id_conflicts_stay_refused(conflict: str) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, images=[object(), object()])
    origin = _authored_field_source(origin, "summary", "Use the style of <Picture 1>.")
    context = _context(origin)
    authority = context.semantic_authority
    fields = tuple(
        replace(field, text=field.text + " Changed.")
        if field.heading == "summary" and conflict == "text"
        else replace(field, asset_ids=(*field.asset_ids, "image_2"))
        if field.heading == "summary" and conflict == "extra_binding"
        else field
        for field in authority.global_fields
    )
    context = replace(context, semantic_authority=replace(authority, global_fields=fields))
    admitted = _admission(origin, context, canonical=True)
    assert isinstance(admitted, StoryboardAdmissionRefusalV1)
    assert admitted.code is StoryboardAdmissionRefusalCodeV1.STORYBOARD_UNAVAILABLE


def _assert_subject_materialization(origin: Source, *, canonical: bool, target: int) -> None:
    context = _context(origin, target=target)
    admitted = _admission(origin, context, canonical=canonical)
    assert isinstance(admitted, ProductionStoryboardAdmissionV2), getattr(admitted, "code", None)
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalV2), getattr(proposal, "code", None)
    assert proposal.importable and proposal.blocker_codes == ()
    reports = materialized(origin, context, proposal)
    assert len(reports) == target // 10
    source_subjects = origin.report.plan.intent_graph.subjects
    source_ordinals = {
        f"<Subject {ordinal}>": row.subject_id for ordinal, row in enumerate(source_subjects, 1)
    }
    for report in reports:
        assert report.validation.status.value == "passed"
        assert ValidatedReportEnvelope.from_report(report).is_execution_ready
        assert report.plan.intent_graph.subjects == source_subjects, "source_subject_order"
        derived_ordinals = {
            f"<Subject {ordinal}>": row.subject_id
            for ordinal, row in enumerate(report.plan.intent_graph.subjects, 1)
        }
        for token, subject_id in source_ordinals.items():
            assert token in report.prompt_document.text
            assert derived_ordinals[token] == subject_id, "source_subject_ordinal"
    assert _import_receipts(origin, canonical=canonical, target=target) == len(reports)


@pytest.mark.parametrize("case", ("ordinary_subject", "mixed_frame_subject"))
@pytest.mark.parametrize("variant", ("authored", "explicit", "default"))
@pytest.mark.parametrize("canonical", (False, True), ids=("reviewed", "canonical"))
@pytest.mark.parametrize("target", (10, 20), ids=("one_clip", "two_clips"))
def test_subject_context_without_dialogue_materializes_and_imports(
    case: str,
    variant: str,
    canonical: bool,
    target: int,
) -> None:
    if variant == "default":
        origin = _subject_source(frame=case == "mixed_frame_subject", subject_asset="image_1")
    else:
        origin, _, _, _, _ = _case(case, explicit_subjects=variant == "explicit")
    expected_ids = ("subject_sphere",) if variant == "explicit" else ()
    assert origin.report.plan.intent_graph.segments[0].subject_ids == expected_ids
    _assert_subject_materialization(origin, canonical=canonical, target=target)


@pytest.mark.parametrize("canonical", (False, True), ids=("reviewed", "canonical"))
@pytest.mark.parametrize("target", (10, 20), ids=("one_clip", "two_clips"))
def test_subject_ordinals_keep_earlier_unmentioned_subject(
    canonical: bool,
    target: int,
) -> None:
    origin = _subject_source(
        frame=False,
        subject_asset="image_1",
        subjects=(
            IntentSubject("subject_earlier", "the earlier sphere", ("image_1",)),
            IntentSubject("subject_later", "the later sphere", ("image_1",)),
        ),
    )
    origin = _authored_field_source(origin, "summary", "Keep <Subject 2> in the quiet room.")
    _assert_subject_materialization(origin, canonical=canonical, target=target)


def test_undefined_subject_label_still_fails_sidebar_validation() -> None:
    origin = _subject_source(frame=False, subject_asset="image_1")
    snapshot = origin.snapshot
    summary = next(
        row.body for row in origin.report.prompt_document.sections if row.heading == "summary"
    )
    staged = origin.sidebar.dispatch(
        {
            "schema": "h3.context.sidebar.action.v2",
            "workspace_id": snapshot.workspace_id,
            "expected_revision": snapshot.report_revision,
            "expected_report_fingerprint": snapshot.report_fingerprint,
            "action": "stage_prompt",
            "payload": {
                "reason": "Specify the scene",
                "prompt_text": origin.report.prompt_document.text.replace(
                    "summary: " + summary, "summary: Keep <Subject 2> in the room.", 1
                ),
            },
        }
    )
    assert isinstance(staged, SidebarWorkspaceProjection)
    validated = origin.sidebar.dispatch(
        {
            "schema": "h3.context.sidebar.action.v2",
            "workspace_id": staged.workspace_id,
            "expected_revision": staged.report_revision,
            "expected_report_fingerprint": staged.report_fingerprint,
            "action": "validate",
            "payload": {},
        }
    )
    assert isinstance(validated, SidebarWorkspaceProjection)
    assert validated.validation_status == "failed"
    assert "reference.invalid_label" in {row["code"] for row in validated.diagnostics}
