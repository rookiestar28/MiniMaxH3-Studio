"""Frame roles belong to outer clips; authored content keeps its reference identity."""

from __future__ import annotations

import json
import re
from dataclasses import fields, replace
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
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
from comfyui_h3_context.adapters.production_context_materializer import (
    CanonicalProductionMaterializer,
)
from comfyui_h3_context.adapters.production_planning_service import ProductionPlanningService
from comfyui_h3_context.adapters.production_planning_source import (
    build_production_planning_context,
)
from comfyui_h3_context.core import production_storyboard, rendering
from comfyui_h3_context.core.canonical_context_pipeline import CanonicalContextPipelineError
from comfyui_h3_context.core.contracts import TaskMode
from comfyui_h3_context.core.errors import PromptRenderingError
from comfyui_h3_context.core.production_duration import (
    ProductionDurationIntentV1,
    SegmentationPolicyV1,
)
from comfyui_h3_context.core.production_import import ProductionImportError
from comfyui_h3_context.core.production_semantics import (
    ProductionLocalShotV1,
    ProductionSemanticError,
    SubjectDefinitionV1,
    TimedSemanticSpanV1,
    assert_complete_semantic_census,
    slice_production_semantics,
)
from comfyui_h3_context.core.production_storyboard import (
    ProductionPlanningContextV1,
    ProductionPlanningContextV2,
    ProductionStoryboardAdmissionRequestV1,
    ProductionStoryboardAdmissionService,
    ProductionStoryboardAdmissionV1,
    ProductionStoryboardAdmissionV2,
    ProposalBlockerCodeV1,
    SegmentationProposalRefusalCodeV1,
    SegmentationProposalRefusalV1,
    SegmentationProposalV1,
    SegmentationProposalV2,
    StoryboardAdmissionRefusalV1,
    StoryboardShotV1,
    StoryboardSourceKindV1,
    build_segmentation_proposal,
)
from comfyui_h3_context.core.production_workbench import ProductionWorkbenchProjection
from comfyui_h3_context.core.sidebar_workspace import SidebarWorkspaceProjection

_IDENTITIES = json.loads(
    (Path(__file__).parent / "fixtures" / "single_segment_planning_identity.json").read_text(
        encoding="utf-8"
    )
)


def _registry(mode: TaskMode) -> dict[str, object]:
    return {
        TaskMode.T2VA: {},
        TaskMode.I2VA: {"first_frame": object()},
        TaskMode.L2VA: {"last_frame": object()},
        TaskMode.FL2VA: {"first_frame": object(), "last_frame": object()},
        TaskMode.REF2VA: {
            "first_frame": object(),
            "last_frame": object(),
            "images": [object()],
        },
    }[mode]


def _context(
    origin: Source,
    target: int,
    *,
    planning_id: str = "planning.ownership",
    policy: SegmentationPolicyV1 = SegmentationPolicyV1.FIXED_10,
) -> ProductionPlanningContextV2:
    return build_production_planning_context(
        origin.snapshot,
        planning_context_id=planning_id,
        revision=1,
        duration_intent=ProductionDurationIntentV1(target_seconds=target, policy=policy),
    )


def _legacy(context: ProductionPlanningContextV2) -> ProductionPlanningContextV1:
    return ProductionPlanningContextV1(
        **{
            item.name: getattr(context, item.name)
            for item in fields(ProductionPlanningContextV1)
            if item.init
        }
    )


def _admit(
    context: ProductionPlanningContextV1,
    rows: tuple[StoryboardShotV1, ...],
    *,
    request_id: str = "request.ownership",
) -> ProductionStoryboardAdmissionV1:
    admitted = ProductionStoryboardAdmissionService().admit(
        context,
        ProductionStoryboardAdmissionRequestV1(
            request_id=request_id,
            planning_context_id=context.planning_context_id,
            planning_context_revision=context.revision,
            planning_context_fingerprint=context.fingerprint,
            optimized_candidate_id=context.optimized_candidate_id,
            optimized_candidate_text_fingerprint=context.optimized_candidate_text_fingerprint,
            production_duration_intent_fingerprint=context.duration_intent_fingerprint,
            source_kind=StoryboardSourceKindV1.USER_REVIEWED_TYPED_ROWS,
            typed_rows=rows,
            user_reviewed=True,
        ),
    )
    assert isinstance(admitted, ProductionStoryboardAdmissionV1), "admission_kind"
    return admitted


def _proposal(
    context: ProductionPlanningContextV2, rows: tuple[StoryboardShotV1, ...]
) -> SegmentationProposalV2:
    admitted = _admit(context, rows)
    assert isinstance(admitted, ProductionStoryboardAdmissionV2), "admission_version"
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalV2), "proposal_kind"
    return proposal


@pytest.mark.parametrize("mode", tuple(TaskMode))
@pytest.mark.parametrize("version", ("v1", "v2"))
def test_single_segment_identity_is_unchanged(mode: TaskMode, version: str) -> None:
    origin = source(mode, SINGLE, 10, **_registry(mode))
    current = _context(origin, 10, planning_id="planning.identity")
    context = _legacy(current) if version == "v1" else current
    label = "" if mode is TaskMode.T2VA else " <Picture 1>"
    rows = (
        StoryboardShotV1(
            "identity_shot",
            1,
            0,
            10_000,
            "A sphere crosses the room.",
            exact_dialogue=("Keep  two spaces." + label,),
            visible_text=("A fixed sign." + label,),
        ),
    )
    admitted = _admit(context, rows, request_id="request.identity")
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalV1), "n1_proposal_kind"
    actual = {
        "context": context.fingerprint,
        "admission": admitted.fingerprint,
        "proposal": proposal.fingerprint,
        "prompt_sha256": "sha256:"
        + sha256(proposal.segments[0].local_prompt.encode("utf-8")).hexdigest(),
    }
    assert actual == _IDENTITIES[f"{version}.{mode.value}"]


@pytest.mark.parametrize(
    ("frame_names", "expected"),
    [
        (("first_frame",), (("first_frame_1", "image_1"), ("image_1",))),
        (("last_frame",), (("image_1",), ("last_frame_1", "image_1"))),
        (
            ("first_frame", "last_frame"),
            (("first_frame_1", "image_1"), ("last_frame_1", "image_1")),
        ),
    ],
)
def test_ref2va_frames_are_owned_only_by_outer_segments(
    frame_names: tuple[str, ...], expected: tuple[tuple[str, ...], ...]
) -> None:
    registry = {name: object() for name in frame_names}
    registry["images"] = [object()]
    origin = source(TaskMode.REF2VA, SINGLE, 10, **registry)
    context = _context(origin, 20)
    proposal = _proposal(context, rows_at((10,), 20))
    assert tuple(segment.asset_ids for segment in proposal.segments) == expected
    assert proposal.importable
    reports = materialized(origin, context, proposal)
    for ordinal, report in enumerate(reports, 1):
        actual_claims = (
            report.prompt_document.text.count("the first frame of the target video"),
            report.prompt_document.text.count("the final frame of the target video"),
        )
        assert actual_claims == (
            int("first_frame" in frame_names and ordinal == 1),
            int("last_frame" in frame_names and ordinal == len(reports)),
        )


@pytest.mark.parametrize("frame_name", ("first_frame", "last_frame"))
def test_ref2va_empty_reference_segment_is_blocked(frame_name: str) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, **{frame_name: object()})
    context = _context(origin, 20)
    proposal = _proposal(context, rows_at((10,), 20))
    assert proposal.blocker_codes == (ProposalBlockerCodeV1.REQUIRED_ASSET_MISSING,)
    assert not proposal.importable


@pytest.mark.parametrize("frame_name", ("first_frame", "last_frame"))
@pytest.mark.parametrize("form", ("exact_dialogue", "visible_text", "label_free"))
def test_legacy_frame_bearing_ref2va_multi_segment_fails_closed(frame_name: str, form: str) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, images=[object()], **{frame_name: object()})
    context = _legacy(_context(origin, 20))
    rows = rows_at((10,), 20)
    if form != "label_free":
        changes: dict[str, Any] = {form: ("Exact <Picture 1>.",)}
        rows = (rows[0], replace(rows[1], **changes))
    admitted = _admit(context, rows)
    assert type(admitted) is ProductionStoryboardAdmissionV1
    assert admitted.shots == rows
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalRefusalV1), "legacy_frame_refusal"
    assert proposal.code is SegmentationProposalRefusalCodeV1.SEMANTIC_PRESERVATION_UNAVAILABLE


def test_legacy_ordinary_reference_multi_segment_still_plans() -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, images=[object()])
    context = _legacy(_context(origin, 20))
    admitted = _admit(context, rows_at((10,), 20))
    proposal = build_segmentation_proposal(context, admitted)
    assert type(proposal) is SegmentationProposalV1
    assert proposal.importable
    assert tuple(segment.asset_ids for segment in proposal.segments) == (
        ("image_1",),
        ("image_1",),
    )


def _canonical_admission(
    origin: Source, context: ProductionPlanningContextV2
) -> ProductionStoryboardAdmissionV2:
    admitted = ProductionStoryboardAdmissionService().admit(
        context,
        ProductionStoryboardAdmissionRequestV1(
            request_id="request.canonical",
            planning_context_id=context.planning_context_id,
            planning_context_revision=context.revision,
            planning_context_fingerprint=context.fingerprint,
            optimized_candidate_id=context.optimized_candidate_id,
            optimized_candidate_text_fingerprint=context.optimized_candidate_text_fingerprint,
            production_duration_intent_fingerprint=context.duration_intent_fingerprint,
            source_kind=StoryboardSourceKindV1.CANONICAL_OPTIMIZED_PROMPT,
            candidate_text=origin.report.prompt_document.text,
        ),
    )
    assert isinstance(admitted, ProductionStoryboardAdmissionV2), "canonical_admission_kind"
    return admitted


def _service_import(
    origin: Source,
    target: int,
    rows: tuple[StoryboardShotV1, ...],
    *,
    canonical: bool = False,
    policy: SegmentationPolicyV1 = SegmentationPolicyV1.FIXED_10,
) -> int:
    production = ProductionWorkspaceRegistry(seed_claim=origin.sidebar.claim_production_seed)
    created = production.dispatch(
        {
            "schema": PRODUCTION_ACTION_SCHEMA,
            "request_id": "ownership.create",
            "action": "create_workspace_from_context",
            "payload": {"context_workspace_handle": origin.snapshot.workspace_id},
        }
    ).projection
    assert isinstance(created, ProductionWorkbenchProjection)
    service = ProductionPlanningService(
        sidebar_registry=origin.sidebar, production_registry=production
    )
    prepared: dict[str, Any] = service.dispatch(
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
                "policy": policy.value,
            },
            "ownership.prepare",
        )
    ).to_wire()
    admitted: dict[str, Any] = service.dispatch(
        _action(
            "admit_storyboard",
            {
                **_selectors(prepared),
                "source_kind": "canonical_optimized_prompt"
                if canonical
                else "user_reviewed_typed_rows",
                "typed_rows": [] if canonical else [row.to_wire() for row in rows],
                "user_reviewed": not canonical,
            },
            "ownership.admit",
        )
    ).to_wire()
    proposed: dict[str, Any] = service.dispatch(
        _action(
            "propose",
            {**_selectors(admitted), "admission_id": admitted["admission_id"]},
            "ownership.propose",
        )
    ).to_wire()
    assert proposed["proposal"]["importable"] is True
    imported: dict[str, Any] = service.dispatch(
        _action(
            "import_plan",
            {**_selectors(proposed), "proposal_id": proposed["proposal"]["proposal_id"]},
            "ownership.import",
        )
    ).to_wire()
    return len(imported["materialization_receipt_fingerprints"])


@pytest.mark.parametrize("canonical", (False, True))
def test_authored_frame_summary_is_carried_with_one_pass_local_labels(canonical: bool) -> None:
    origin = source(
        TaskMode.REF2VA,
        "A plain sphere follows the composition of <Picture 1> and the style of <Picture 2>.",
        10,
        first_frame=object(),
        images=[object()],
    )
    context = _context(origin, 20)
    rows = rows_at((10,), 20)
    admitted = _canonical_admission(origin, context) if canonical else _admit(context, rows)
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalV2), "authored_summary_proposal"
    if canonical:
        # REPLY-550 section 3 / REPLY-556: b7-stage-observation-01 confirms the canonical
        # shot binds the frame in both cuts. Global carry cannot project shot-local content.
        assert admitted.shots[0].asset_ids == ("first_frame_1", "image_1")
        assert proposal.blocker_codes == (ProposalBlockerCodeV1.LOCAL_REFERENCE_UNAVAILABLE,)
        assert not proposal.importable
        return
    assert proposal.importable
    summaries = tuple(
        next(field for field in item.global_fields if field.heading == "summary")
        for item in proposal.semantic_slices
    )
    assert tuple(field.asset_ids for field in summaries) == (
        ("first_frame_1", "image_1"),
        ("image_1",),
    )
    assert summaries[0].text == summaries[1].text
    rendered = proposal.segments[1].local_prompt
    assert "composition of the opening frame of the full video" in rendered
    assert "style of <Picture 1>" in rendered
    assert rendered.count("the first frame of the target video") == 0
    materialized(origin, context, proposal)
    assert _service_import(origin, 20, rows) == 2


def _authored_field_source(origin: Source, heading: str, field: str) -> Source:
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
                "reason": "Specify the scene ambience",
                "prompt_text": origin.report.prompt_document.text.replace(
                    heading + ": " + original, heading + ": " + field, 1
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
    assert validated.validation_status == "passed", "authored_source_valid"
    snapshot = origin.sidebar.snapshot_production_planning_source(
        validated.workspace_id,
        expected_report_revision=validated.report_revision,
        expected_report_fingerprint=validated.report_fingerprint,
    )
    return Source(origin.sidebar, snapshot, snapshot.report)


def _authored_base_source(mode: TaskMode) -> Source:
    origin = source(mode, "A plain sphere crosses a quiet room.", 10, **_registry(mode))
    field = "Room ambience follows the setting shown in <Picture 1>."
    if mode is TaskMode.FL2VA:
        field = "Room ambience follows the settings shown in <Picture 1> and <Picture 2>."
    return _authored_field_source(origin, "overall_soundscape", field)


def test_canonical_plan_level_only_frame_summary_imports() -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    origin = _authored_field_source(
        origin,
        "summary",
        "A sphere follows the composition of <Picture 1> and the style of <Picture 2>.",
    )
    context = _context(origin, 20)
    admitted = _canonical_admission(origin, context)
    assert all(shot.asset_ids == () for shot in admitted.shots)
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalV2), "canonical_global_only_proposal"
    assert proposal.importable
    assert "composition of the opening frame of the full video" in proposal.segments[1].local_prompt
    assert "style of <Picture 1>" in proposal.segments[1].local_prompt
    materialized(origin, context, proposal)
    assert _service_import(origin, 20, (), canonical=True) == 2


@pytest.mark.parametrize("mode", (TaskMode.I2VA, TaskMode.FL2VA))
@pytest.mark.parametrize("canonical", (False, True))
def test_base_authored_frame_field_survives_non_owner_and_empty_middle(
    mode: TaskMode, canonical: bool
) -> None:
    origin = _authored_base_source(mode)
    count = 3 if mode is TaskMode.FL2VA else 2
    target = count * 10
    context = _context(origin, target)
    rows = rows_at(tuple(range(10, target, 10)), target)
    admitted = _canonical_admission(origin, context) if canonical else _admit(context, rows)
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalV2), "base_authored_field_proposal"
    assert proposal.importable
    middle = proposal.segments[1]
    assert middle.asset_ids == ()
    assert "the opening frame of the full video" in middle.local_prompt
    if mode is TaskMode.FL2VA:
        assert "the closing frame of the full video" in middle.local_prompt
    materialized(origin, context, proposal)
    assert _service_import(origin, target, rows) == count


@pytest.mark.parametrize("form", ("exact_dialogue", "visible_text"))
@pytest.mark.parametrize("ordinal", (1, 2))
def test_independent_exact_tuple_cannot_use_an_absent_frame(form: str, ordinal: int) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    context = _context(origin, 20)
    rows = list(rows_at((10,), 20))
    changes: dict[str, Any] = {form: ("Exact <Picture 1>.",)}
    rows[ordinal - 1] = replace(rows[ordinal - 1], **changes)
    proposal = _proposal(context, tuple(rows))
    expected = () if ordinal == 1 else (ProposalBlockerCodeV1.LOCAL_REFERENCE_UNAVAILABLE,)
    assert proposal.blocker_codes == expected


@pytest.mark.parametrize("form", ("exact_dialogue", "visible_text"))
def test_ordinary_image_in_exact_tuple_renumbers_without_losing_other_bytes(form: str) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    context = _context(origin, 20)
    rows = rows_at((10,), 20)
    exact = "Keep  two spaces: <Picture 2>."
    changes: dict[str, Any] = {form: (exact,)}
    rows = (rows[0], replace(rows[1], **changes))
    admitted = _admit(context, rows)
    assert admitted.shots == rows
    proposal = build_segmentation_proposal(context, admitted)
    assert isinstance(proposal, SegmentationProposalV2), "renumbered_exact_proposal"
    assert proposal.blocker_codes == ()
    assert "Keep  two spaces: <Picture 1>." in proposal.segments[1].local_prompt
    if form == "visible_text":
        assert (
            'Visible text remains exactly "Keep  two spaces: <Picture 1>.".'
            in proposal.segments[1].local_prompt
        )


def _with_subject(
    context: ProductionPlanningContextV2, source_asset: str | None
) -> ProductionPlanningContextV2:
    subject = SubjectDefinitionV1(
        subject_id="subject_sphere",
        label="The sphere",
        connection_order=1,
        description=None,
        source_asset_ids=() if source_asset is None else (source_asset,),
    )
    return replace(
        context,
        subject_ids=(subject.subject_id,),
        semantic_authority=replace(context.semantic_authority, subject_definitions=(subject,)),
    )


def test_visible_subject_token_preserves_its_frame_source_obligation() -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    context = _with_subject(_context(origin, 20), "first_frame_1")
    rows = rows_at((10,), 20)
    rows = (rows[0], replace(rows[1], visible_text=("<Subject 1> remains recognizable.",)))
    proposal = _proposal(context, rows)
    assert proposal.blocker_codes == (ProposalBlockerCodeV1.LOCAL_REFERENCE_UNAVAILABLE,)


@pytest.mark.parametrize("source_asset", (None, "image_1", "first_frame_1"))
def test_global_subject_identity_is_never_dropped_for_frame_projection(
    source_asset: str | None,
) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    context = _with_subject(_context(origin, 20), source_asset)
    authority = context.semantic_authority
    context = replace(
        context,
        semantic_authority=replace(
            authority,
            global_fields=tuple(
                replace(
                    field,
                    text="<Subject 1> keeps its appearance.",
                    subject_ids=("subject_sphere",),
                )
                if field.heading == "summary"
                else field
                for field in authority.global_fields
            ),
        ),
    )
    proposal = build_segmentation_proposal(context, _admit(context, rows_at((10,), 20)))
    if source_asset == "first_frame_1":
        assert isinstance(proposal, SegmentationProposalRefusalV1)
        assert proposal.code is SegmentationProposalRefusalCodeV1.STORYBOARD_COVERAGE_INVALID
    else:
        assert isinstance(proposal, SegmentationProposalV2)
        assert proposal.importable
        assert all(
            any(field.subject_ids == ("subject_sphere",) for field in item.global_fields)
            for item in proposal.semantic_slices
        )


@pytest.mark.parametrize("mode", (TaskMode.I2VA, TaskMode.L2VA, TaskMode.FL2VA, TaskMode.REF2VA))
def test_reviewed_three_segment_frame_only_plan_and_explicit_mode_remedies(mode: TaskMode) -> None:
    registry = _registry(mode)
    registry.pop("images", None)
    origin = source(mode, SINGLE, 10, **registry)
    policy = SegmentationPolicyV1.AUTO_STORYBOARD
    context = _context(origin, 30, policy=policy)
    rows = rows_at((8, 20), 30)
    proposal = _proposal(context, rows)
    assert tuple(segment.duration.requested_seconds for segment in proposal.segments) == (8, 12, 10)
    if mode is TaskMode.REF2VA:
        assert proposal.blocker_codes == (ProposalBlockerCodeV1.REQUIRED_ASSET_MISSING,)
        assert tuple(segment.asset_ids for segment in proposal.segments) == (
            ("first_frame_1",),
            (),
            ("last_frame_1",),
        )
        # Empty Ref2VA input fails normalization before the unchanged profile-mismatch guard.
        # The materializer must still fail closed if a caller ignores the proposal blocker.
        materialize = CanonicalProductionMaterializer(
            origin.snapshot, workspace_registry=origin.sidebar
        )
        with pytest.raises(CanonicalContextPipelineError) as failure:
            materialize(context, proposal, proposal.segments[1])
        assert tuple((item.code, item.severity.value) for item in failure.value.diagnostics) == (
            ("duration_snapped", "warning"),
            ("missing_reference_asset", "error"),
        )
    else:
        assert proposal.importable
        assert (
            tuple(segment.task_mode for segment in proposal.segments)
            == {
                TaskMode.I2VA: (TaskMode.I2VA, TaskMode.T2VA, TaskMode.T2VA),
                TaskMode.L2VA: (TaskMode.T2VA, TaskMode.T2VA, TaskMode.L2VA),
                TaskMode.FL2VA: (TaskMode.I2VA, TaskMode.T2VA, TaskMode.L2VA),
            }[mode]
        )
        materialized(origin, context, proposal)
        assert _service_import(origin, 30, rows, policy=policy) == 3


def test_maximum_mixed_registry_preserves_order_and_local_kind_labels() -> None:
    origin = source(
        TaskMode.REF2VA,
        SINGLE,
        10,
        first_frame=object(),
        last_frame=object(),
        images=[object() for _ in range(6)],
        videos=[object(), object()],
        audios=[object(), object()],
    )
    policy = SegmentationPolicyV1.AUTO_STORYBOARD
    context = _context(origin, 30, policy=policy)
    assert len(context.assets) == 12
    proposal = _proposal(context, rows_at((8, 20), 30))
    ordinary = tuple(f"image_{i}" for i in range(1, 7)) + (
        "video_1",
        "video_2",
        "audio_1",
        "audio_2",
    )
    expected = (("first_frame_1", *ordinary), ordinary, ("last_frame_1", *ordinary))
    assert tuple(segment.asset_ids for segment in proposal.segments) == expected
    assert proposal.importable
    reports = materialized(origin, context, proposal)
    for index, report in enumerate(reports):
        assert (
            tuple(asset.asset_id for asset in report.request.reference_registry.assets)
            == expected[index]
        )
        tokens = set(re.findall(r"<(?:Picture|Video|Audio) [0-9]+>", report.prompt_document.text))
        picture_count = 6 if index == 1 else 7
        assert tokens == (
            {f"<Picture {i}>" for i in range(1, picture_count + 1)}
            | {"<Video 1>", "<Video 2>", "<Audio 1>", "<Audio 2>"}
        )


@pytest.mark.parametrize("change", ("missing_everywhere", "wrong_owner", "text_tamper"))
def test_census_refuses_missing_moved_or_tampered_frame_authority(change: str) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    origin = _authored_field_source(origin, "summary", "Use the composition of <Picture 1>.")
    context = _context(origin, 20)
    proposal = _proposal(context, rows_at((10,), 20))
    slices = list(proposal.semantic_slices)
    if change == "text_tamper":
        fields_ = tuple(
            replace(field, text=field.text + " Changed.") for field in slices[0].global_fields
        )
        slices[0] = replace(slices[0], global_fields=fields_)
    else:
        assets: list[tuple[str, ...]] = [("image_1",), ("image_1",)]
        if change == "wrong_owner":
            assets[1] = ("first_frame_1", "image_1")
        slices = [
            slice_production_semantics(
                proposal.semantic_authority,
                segment_id=item.segment_id,
                global_start_milliseconds=item.global_start_milliseconds,
                global_end_milliseconds=item.global_end_milliseconds,
                task_mode=item.task_mode,
                asset_ids=assets[index],
            )
            for index, item in enumerate(slices)
        ]
    with pytest.raises(ProductionSemanticError):
        assert_complete_semantic_census(proposal.semantic_authority, tuple(slices))


@pytest.mark.parametrize("full_source", (False, True))
def test_exact_guard_rejects_one_non_token_byte_change_with_local_renumbering(
    monkeypatch: pytest.MonkeyPatch,
    full_source: bool,
) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    context = _context(origin, 20)
    proposal = _proposal(context, rows_at((10,), 20))
    local = proposal.semantic_slices[1]
    shots = (
        ProductionLocalShotV1(
            "guard_shot", 1, 0, "A sphere pauses.", ("Keep  two spaces: <Picture 2>.",), ()
        ),
    )
    kwargs: dict[str, Any] = (
        {"source_reference_definitions": context.semantic_authority.reference_definitions}
        if full_source
        else {}
    )
    original = rendering.render_prompt_sections
    rendered = rendering.render_production_segment_prompt(
        local,
        shots,
        section_heading="detailed_description",
        clip_duration_seconds=Decimal(10),
        **kwargs,
    )
    assert "Keep  two spaces: <Picture 1>." in rendered.text

    def corrupt(*args: Any, **options: Any) -> str:
        return original(*args, **options).replace("Keep  two spaces:", "Keep two spaces:", 1)

    monkeypatch.setattr(rendering, "render_prompt_sections", corrupt)
    with pytest.raises(PromptRenderingError, match="^Production rendering lost exact text$"):
        rendering.render_production_segment_prompt(
            local,
            shots,
            section_heading="detailed_description",
            clip_duration_seconds=Decimal(10),
            **kwargs,
        )


@pytest.mark.parametrize("conflict", ("text", "extra_binding"))
def test_frame_label_normalization_keeps_genuine_equal_id_conflicts_closed(conflict: str) -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    origin = _authored_field_source(origin, "summary", "Use the composition of <Picture 1>.")
    context = _context(origin, 20)
    fields_ = tuple(
        replace(field, text=field.text + " Changed.")
        if conflict == "text" and field.heading == "summary"
        else replace(field, asset_ids=(*field.asset_ids, "image_1"))
        if conflict == "extra_binding" and field.heading == "summary"
        else field
        for field in context.semantic_authority.global_fields
    )
    context = replace(
        context, semantic_authority=replace(context.semantic_authority, global_fields=fields_)
    )
    request = ProductionStoryboardAdmissionRequestV1(
        request_id="request.conflicting",
        planning_context_id=context.planning_context_id,
        planning_context_revision=context.revision,
        planning_context_fingerprint=context.fingerprint,
        optimized_candidate_id=context.optimized_candidate_id,
        optimized_candidate_text_fingerprint=context.optimized_candidate_text_fingerprint,
        production_duration_intent_fingerprint=context.duration_intent_fingerprint,
        source_kind=StoryboardSourceKindV1.CANONICAL_OPTIMIZED_PROMPT,
        candidate_text=origin.report.prompt_document.text,
    )
    admitted = ProductionStoryboardAdmissionService().admit(context, request)
    assert isinstance(admitted, StoryboardAdmissionRefusalV1)
    assert admitted.code.value == "storyboard_unavailable"


def test_timed_frame_binding_is_not_projected_like_a_global_field() -> None:
    origin = source(TaskMode.REF2VA, SINGLE, 10, first_frame=object(), images=[object()])
    context = _context(origin, 20)
    context = replace(
        context,
        semantic_authority=replace(
            context.semantic_authority,
            timed_spans=(
                TimedSemanticSpanV1("timed_frame", "action", 10_000, 11_000, "Use <Picture 1>."),
            ),
        ),
    )
    admitted = _admit(context, rows_at((10,), 20))
    proposed = build_segmentation_proposal(context, admitted)
    assert isinstance(proposed, SegmentationProposalRefusalV1)
    assert proposed.code is SegmentationProposalRefusalCodeV1.STORYBOARD_COVERAGE_INVALID


@pytest.mark.parametrize("mode", (TaskMode.REF2VA, TaskMode.I2VA))
def test_cross_profile_rule_fault_is_refused_before_publication(
    monkeypatch: pytest.MonkeyPatch, mode: TaskMode
) -> None:
    origin = source(mode, SINGLE, 10, first_frame=object())
    context = _context(origin, 20)
    rows = rows_at((10,), 20)
    original = production_storyboard._task_assets

    def faulty_table(
        current: ProductionPlanningContextV1, ordinal: int, count: int
    ) -> tuple[TaskMode, tuple[str, ...], bool]:
        actual_mode, assets, ready = original(current, ordinal, count)
        if mode is TaskMode.REF2VA and not assets:
            return TaskMode.T2VA, (), True
        if mode is TaskMode.I2VA and ordinal == 1:
            return TaskMode.REF2VA, assets, ready
        return actual_mode, assets, ready

    # Fault only the shared task rule. Replay, source joins, canonical planning and publication
    # remain real, proving the profile guard also closes an internally consistent rule mistake.
    with monkeypatch.context() as fault:
        fault.setattr(production_storyboard, "_task_assets", faulty_table)
        proposal = _proposal(context, rows)
    segment = proposal.segments[1 if mode is TaskMode.REF2VA else 0]
    materializer = CanonicalProductionMaterializer(
        origin.snapshot, workspace_registry=origin.sidebar
    )
    before = set(origin.sidebar._entries)
    with pytest.raises(ProductionImportError, match="^segment_context_proposal_mismatch$") as error:
        materializer(context, proposal, segment)
    assert error.value.__cause__ is not None
    assert error.value.__cause__.args == ("current_proposal_task_assets",)
    assert set(origin.sidebar._entries) == before
    assert not materializer._lease.locked()
    with monkeypatch.context() as fault:
        fault.setattr(production_storyboard, "_task_assets", faulty_table)
        with pytest.raises(ProductionImportError, match="^segment_context_profile_mismatch$"):
            materializer(context, proposal, segment)
    assert set(origin.sidebar._entries) == before
    assert not materializer._lease.locked()
