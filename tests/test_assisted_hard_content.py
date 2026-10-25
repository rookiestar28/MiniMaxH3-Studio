"""Hard-content invariants across the real assisted-action lifecycle."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import pytest
from test_assisted_draft import RecordingModel
from test_audit_override import make_report
from test_comfyui_assisted_draft import SESSION_ID, Exchange, _state

from comfyui_h3_context.adapters.assisted_draft_execution import (
    build_assisted_guarantee,
    build_assisted_instruction,
)
from comfyui_h3_context.adapters.comfyui_provider_settings import ProviderSettingsSessionRegistry
from comfyui_h3_context.adapters.comfyui_sidebar_workspace import (
    SIDEBAR_ACTION_SCHEMA,
    SidebarWorkspaceRegistry,
    dispatch_assisted_sidebar_action,
)
from comfyui_h3_context.core import (
    ContentScope,
    ExecutionCorrelation,
    ForbiddenContent,
    HardConstraintSet,
    RequiredContent,
    SidebarWorkspaceProjection,
    build_native_h3_wiring,
)
from comfyui_h3_context.core.assisted_draft import (
    DraftCandidate,
    DraftGuarantee,
    RepairShape,
    build_repair_instruction,
    run_assisted_draft,
)
from comfyui_h3_context.core.errors import SidebarWorkspaceError
from comfyui_h3_context.core.hard_content import hard_content_violations
from comfyui_h3_context.core.linting import _check_security_and_constraints
from comfyui_h3_context.nodes import H3ContextValidatorNode


def _report() -> Any:
    hard = HardConstraintSet(
        constraints=(
            RequiredContent("required", ContentScope.GENERAL, "red kite"),
            ForbiddenContent("forbidden", ContentScope.GENERAL, "cobalt marble"),
        ),
    )
    report = make_report(hard=hard)
    return H3ContextValidatorNode().validate(report.plan, report.prompt_document)[1]


def _route(kind: str) -> tuple[Any, Any, Any, Any]:
    report = _report()
    original = report.prompt_document.text
    candidate = (
        original.replace("red kite", "kite")
        if kind == "required"
        else original + " A cobalt marble."
    )
    assert candidate != original
    workspaces = SidebarWorkspaceRegistry(max_entries=2, ttl_seconds=60)
    workspace = workspaces.publish(
        report, build_native_h3_wiring(report), ExecutionCorrelation("content", "1")
    )
    providers = ProviderSettingsSessionRegistry(state_factory=_state)
    exchange = Exchange(candidate, candidate)
    root = {
        "schema": SIDEBAR_ACTION_SCHEMA,
        "workspace_id": workspace.workspace_id,
        "expected_revision": workspace.report_revision,
        "expected_report_fingerprint": workspace.report_fingerprint,
    }

    def dispatch(action: str, payload: dict[str, object]) -> Any:
        return asyncio.run(
            dispatch_assisted_sidebar_action(
                {**root, "action": action, "payload": payload},
                SESSION_ID,
                workspace_registry=workspaces,
                provider_registry=providers,
                exchange_factory=lambda _snapshot: exchange,
            )
        )

    return dispatch, workspaces, root, exchange


@pytest.mark.parametrize("action", ["optimize_prompt", "refine_prompt"])
@pytest.mark.parametrize("kind", ["required", "forbidden"])
def test_assisted_route_never_accepts_a_new_hard_content_violation(
    action: str, kind: str, record_property: Callable[[str, object], None]
) -> None:
    dispatch, workspaces, root, exchange = _route(kind)
    result = dispatch(action, {} if action == "optimize_prompt" else {"instruction": "Clarify."})
    if result["state"] == "proposal":
        proposal = result["proposal"]
        accepted = dispatch(
            "accept_assisted_proposal",
            {
                "proposal_id": proposal["proposal_id"],
                "expected_proposal_revision": proposal["proposal_revision"],
            },
        )
        validated = workspaces.dispatch(
            {
                **root,
                "expected_revision": accepted.report_revision,
                "expected_report_fingerprint": accepted.report_fingerprint,
                "action": "validate",
                "payload": {},
            }
        )
        assert isinstance(validated, SidebarWorkspaceProjection)
        code = (
            "constraint.required_content_lost"
            if kind == "required"
            else "constraint.forbidden_content_present"
        )
        assert code in {row["code"] for row in validated.diagnostics}
        record_property("published_and_accepted", True)
        record_property("validate_diagnostic", code)
        # Before the fix this reaches Accept, and only the next Validate rejects the text.
        assert validated.to_wire()["validation_status"] == "passed"
    else:
        assert result["state"] == "failed"
        expected = (
            "prompt_model.repair_user_text_altered"
            if kind == "required"
            else "prompt_model.repair_forbidden_content_added"
        )
        assert result["execution"]["outcome"]["outcome_id"] == expected
        assert result["proposal"] is None and result["execution"]["draft"] is None
        assert workspaces.get(root["workspace_id"]).prompt_text == _report().prompt_document.text
        assert all(value not in json.dumps(result) for value in ("red kite", "cobalt marble"))
        assert len([call for call in exchange.calls if call[1] == "/api/chat"]) == 2


@pytest.mark.parametrize("kind", ["required", "forbidden"])
def test_publish_edit_and_accept_recheck_hard_content(kind: str) -> None:
    dispatch, workspaces, root, exchange = _route(kind)
    source = _report()
    good = source.prompt_document.text
    bad = good.replace("red kite", "kite") if kind == "required" else good + " A cobalt marble."
    # Force publication to inspect an otherwise successful execution from a weaker guarantee.
    from unittest.mock import patch

    with patch("comfyui_h3_context.core.assisted_draft.hard_content_violations", return_value=()):
        failed = dispatch("optimize_prompt", {})
    expected = (
        "prompt_model.proposal_user_text_altered"
        if kind == "required"
        else "prompt_model.proposal_forbidden_content_added"
    )
    assert failed["state"] == "failed"
    assert failed["execution"]["outcome"]["outcome_id"] == expected
    exchange.answers[:] = [good]
    created = dispatch("optimize_prompt", {})
    proposal = created["proposal"]
    payload = {
        "proposal_id": proposal["proposal_id"],
        "expected_proposal_revision": proposal["proposal_revision"],
    }
    edited = dispatch("edit_assisted_proposal", {**payload, "prompt_text": bad})
    assert edited["state"] == "failed"
    assert edited["execution"]["outcome"]["outcome_id"] == expected
    # Exercise the final boundary even if a future caller bypasses the edit validator.
    workspaces._assisted_proposals[proposal["proposal_id"]].candidate_text = bad
    with pytest.raises(SidebarWorkspaceError) as refusal:
        dispatch("accept_assisted_proposal", payload)
    assert ("forbidden_content" in refusal.value.code) is (kind == "forbidden")
    assert workspaces.get(root["workspace_id"]).prompt_text == good


@pytest.mark.parametrize("kind", ["required", "forbidden"])
def test_first_candidate_repairs_once_and_repaired_content_is_adopted(kind: str) -> None:
    report = _report()
    good = report.prompt_document.text
    bad = good.replace("red kite", "kite") if kind == "required" else good + " A cobalt marble."
    model = RecordingModel(DraftCandidate(bad), DraftCandidate(good))
    result = run_assisted_draft(
        plan=report.plan,
        template=report.prompt_document,
        guarantee=build_assisted_guarantee(report),
        model=model,
        instruction="Clarify.",
        evidence_fingerprint="sha256:content",
    )
    assert result.usable and result.attempts == 2
    assert result.adoption is not None and result.adoption.adopted
    assert result.candidate_text == good
    violation_line = model.instructions[1].splitlines()[1]
    expected = (
        "constraint.required_content_lost"
        if kind == "required"
        else "constraint.forbidden_content_present"
    )
    assert violation_line == "violations: " + expected
    assert model.instructions[1].splitlines()[-1] == _EXPECTED_PRESERVE


@pytest.mark.parametrize("fixed", [False, True])
def test_existing_violations_do_not_become_new_preservation_requirements(fixed: bool) -> None:
    report = _report()
    good = report.prompt_document.text
    bad = good.replace("red kite", "kite") + " A cobalt marble."
    current = replace(report, prompt_document=replace(report.prompt_document, text=bad))
    guarantee = build_assisted_guarantee(current)
    assert guarantee.required_content == guarantee.forbidden_content == ()
    model = RecordingModel(DraftCandidate(good if fixed else bad))
    result = run_assisted_draft(
        plan=current.plan,
        template=current.prompt_document,
        guarantee=guarantee,
        model=model,
        instruction="Clarify.",
        evidence_fingerprint="sha256:existing",
    )
    assert result.usable and result.attempts == 1
    SidebarWorkspaceRegistry._validate_assisted_candidate(current, result.candidate_text, guarantee)


def test_new_guarantee_fields_never_change_first_request_or_repair_preservation_bytes() -> None:
    report = _report()
    guarantee = build_assisted_guarantee(report)
    assert guarantee.required_content and guarantee.forbidden_content
    assert build_assisted_instruction(report, guarantee) == _EXPECTED_V1
    assert (
        build_assisted_instruction(report, guarantee, revision_instruction="Clarify.")
        == _EXPECTED_V2
    )
    repair = build_repair_instruction(guarantee, (), RepairShape.NARROW_TEXT_CORRECTION)
    assert repair.splitlines()[-1] == _EXPECTED_PRESERVE


@pytest.mark.parametrize("field", ["required_content", "forbidden_content"])
@pytest.mark.parametrize("value", [["invalid"], ("",), ("x" * 4097,), ("x",) * 65])
def test_guarantee_content_fields_keep_existing_span_bounds(field: str, value: Any) -> None:
    from comfyui_h3_context.core.prompt_model_provider import PromptModelContractError

    with pytest.raises(PromptModelContractError) as error:
        DraftGuarantee((), (), **{field: value})
    assert str(error.value) == "guarantee_" + field


@pytest.mark.parametrize(
    "required,forbidden,text",
    [
        ((), (), "z"),
        ((), (), "text"),
        (("a",), (), "a"),
        (("a",), (), "z"),
        (("a",), (), "cat"),
        (("A",), (), "a"),
        (("a",), (), "A"),
        ((), ("a",), "cat"),
        ((), ("A",), "a"),
        ((), ("a",), "z"),
        (("é",), (), "e\u0301"),
        (("e\u0301",), (), "é"),
        (("貓",), (), "小貓"),
        ((), ("猫",), "小貓"),
        (("Ａ",), (), "A"),
        (("a", "a"), (), "z"),
        ((), ("a", "a"), "a"),
        (("ab", "b"), (), "ab"),
        (("a",), ("ab",), "ab"),
        ((" ",), ("\n",), "\n"),
        (("a.b",), (), "a.b"),
        ((), ("a.b",), "axb"),
        (("ß",), ("ss",), "SS"),
        (("😀",), (), "a😀b"),
    ],
    ids=[f"literal-{i:02}" for i in range(24)],
)
def test_lint_and_assisted_guard_share_the_exact_literal_predicate(
    required: tuple[str, ...],
    forbidden: tuple[str, ...],
    text: str,
) -> None:
    constraints = HardConstraintSet(
        tuple(RequiredContent(f"r{i}", ContentScope.GENERAL, s) for i, s in enumerate(required))
        + tuple(ForbiddenContent(f"f{i}", ContentScope.GENERAL, s) for i, s in enumerate(forbidden))
    )
    report = _report()
    plan = replace(
        report.plan,
        request=replace(report.request, hard_constraints=constraints),
        hard_constraints=constraints,
    )
    findings: list[Any] = []
    _check_security_and_constraints(plan, replace(report.prompt_document, text=text), findings)
    expected = [
        ("constraint.required_content_lost", i) for i, s in enumerate(required) if s not in text
    ]
    expected += [
        ("constraint.forbidden_content_present", i) for i, s in enumerate(forbidden) if s in text
    ]
    assert list(hard_content_violations(required, forbidden, text)) == expected
    assert [(row.code, row.location) for row in findings] == [
        (code, "hard_constraints." + ("r" if code.endswith("lost") else "f") + str(i))
        for code, i in expected
    ]
    assert all(row.severity.value == "error" for row in findings)


def test_lint_hard_content_diagnostic_bytes_stay_unchanged() -> None:
    report = _report()
    findings: list[Any] = []
    text = report.prompt_document.text.replace("red kite", "kite") + " A cobalt marble."
    _check_security_and_constraints(
        report.plan, replace(report.prompt_document, text=text), findings
    )
    assert [row.to_wire() for row in findings] == [
        {
            "severity": "error",
            "code": "constraint.required_content_lost",
            "message": "declared required content is absent from the prompt",
            "location": "hard_constraints.required",
            "remediation": "Restore the required content in the owned prompt section.",
        },
        {
            "severity": "error",
            "code": "constraint.forbidden_content_present",
            "message": "forbidden content appears in the prompt",
            "location": "hard_constraints.forbidden",
            "remediation": "Remove the forbidden value and re-render; do not auto-rewrite it.",
        },
    ]


# Literal pre-change request bytes, captured before the production guard change.
_EXPECTED_V1 = (
    "Improve the current H3 prompt while preserving every typed fact a"
    'nd exact span.\n{"schema":"h3.context.assisted_draft.request.v1","'
    'task_mode":"t2va","requested_duration_seconds":5.167,"effective_d'
    'uration_seconds":5.166666666666667,"effective_frame_count":124,"r'
    'eference_registry":{"assets":[],"labels":[]},"hard_constraints":{'
    '"constraints":[{"constraint_id":"required","kind":"required","sco'
    'pe":"general","content":"red kite","asset_id":null,"location":nul'
    'l},{"constraint_id":"forbidden","kind":"forbidden","scope":"gener'
    'al","content":"cobalt marble","asset_id":null,"location":null}],"'
    'transformations":[]},"required_reference_labels":[],"preserve_exa'
    'ctly":[],"current_prompt":"integrated_multimodal_description: [Sh'
    "ot 1] A red kite crosses the sky while the camera follows its arc"
    ". Required general content: red kite.\\n\\noverall_soundscape: Not "
    'specified.\\n\\nnon_diegetic_music: N/A"}'
)
_EXPECTED_V2 = (
    "Apply revision_instruction to current_prompt; change only what it"
    ' asks while preserving every typed fact and exact span.\n{"schema"'
    ':"h3.context.assisted_draft.request.v2","task_mode":"t2va","reque'
    'sted_duration_seconds":5.167,"effective_duration_seconds":5.16666'
    '6666666667,"effective_frame_count":124,"reference_registry":{"ass'
    'ets":[],"labels":[]},"hard_constraints":{"constraints":[{"constra'
    'int_id":"required","kind":"required","scope":"general","content":'
    '"red kite","asset_id":null,"location":null},{"constraint_id":"for'
    'bidden","kind":"forbidden","scope":"general","content":"cobalt ma'
    'rble","asset_id":null,"location":null}],"transformations":[]},"re'
    'quired_reference_labels":[],"preserve_exactly":[],"current_prompt'
    '":"integrated_multimodal_description: [Shot 1] A red kite crosses'
    " the sky while the camera follows its arc. Required general conte"
    "nt: red kite.\\n\\noverall_soundscape: Not specified.\\n\\nnon_dieget"
    'ic_music: N/A","revision_instruction":"Clarify."}'
)
_EXPECTED_PRESERVE = "preserve_exactly: "
