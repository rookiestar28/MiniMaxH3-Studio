"""Repair selection must cross runner boundaries and freeze receipts must fail closed."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from importlib import import_module, util
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]


def tool() -> ModuleType:
    assert util.find_spec("scripts.repair_prefreeze_check") is not None, (
        "missing pre-freeze selector and receipt verification behavior"
    )
    return import_module("scripts.repair_prefreeze_check")


def vitest_batch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    report_text: str | None = "valid",
    process_exit: int = 0,
    case_status: str = "passed",
    report_name: str = "sample",
    empty_cases: bool = False,
) -> tuple[list[dict[str, Any]], list[list[str]], Path]:
    rows: list[dict[str, Any]] = [{"test": "frontend/tests/sample.test.ts"}]
    logs = tmp_path / ".tmp/logs"
    logs.mkdir(parents=True)
    calls: list[list[str]] = []
    report = {
        "testResults": [
            {
                "name": str(tmp_path / f"frontend/tests/{report_name}.test.ts"),
                "status": "passed",
                "assertionResults": [] if empty_cases else [{"status": case_status}],
            }
        ]
    }
    monkeypatch.setattr(tool(), "_node_cli", lambda *args: ["node", "vitest-cli"])

    def execute(
        cwd: Path, command: list[str], log: Path, env: dict[str, str]
    ) -> subprocess.CompletedProcess[str]:
        assert cwd == tmp_path / "frontend"
        calls.append(command)
        stdout = '{"fixtureDiagnostic":true}\n' + json.dumps(report)
        log.write_text(stdout + "\nfixture stderr\n", encoding="utf-8")
        for argument in command:
            if argument.startswith("--outputFile=") and report_text is not None:
                destination = Path(argument.split("=", 1)[1])
                assert destination.is_absolute()
                destination.write_text(
                    json.dumps(report) if report_text == "valid" else report_text,
                    encoding="utf-8",
                )
        return subprocess.CompletedProcess(command, process_exit, stdout, "fixture stderr")

    monkeypatch.setattr(tool(), "_execute", execute)
    return rows, calls, logs


def test_vitest_batch_uses_native_report_despite_noisy_stdout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows, calls, logs = vitest_batch(tmp_path, monkeypatch)
    tool()._batch_tests(tmp_path, "vitest", rows, logs, {})
    assert rows[0]["status"] == "PASS" and rows[0]["cases"] == 1
    assert rows[0]["runner_process_exit"] == 0
    assert len(calls) == 1
    assert "fixtureDiagnostic" in (logs / "vitest.txt").read_text()
    assert "fixture stderr" in (logs / "vitest.txt").read_text()


@pytest.mark.parametrize("report_text", [None, "", '{"testResults":', "{}\n{}"])
def test_vitest_batch_refuses_absent_or_invalid_native_report_without_stdout_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, report_text: str | None
) -> None:
    rows, calls, logs = vitest_batch(tmp_path, monkeypatch, report_text=report_text)
    with pytest.raises((OSError, ValueError)):
        tool()._batch_tests(tmp_path, "vitest", rows, logs, {})
    assert len(calls) == 1
    assert rows[0]["status"] == "FAIL" and rows[0]["runner_process_exit"] == 0


def test_vitest_batch_refuses_existing_report_before_launch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows, calls, logs = vitest_batch(tmp_path, monkeypatch)
    report = logs / "vitest-report.json"
    report.write_text("original evidence", encoding="utf-8")
    with pytest.raises(tool().Refusal, match="report.*exists"):
        tool()._batch_tests(tmp_path, "vitest", rows, logs, {})
    assert calls == [] and report.read_text() == "original evidence"


@pytest.mark.parametrize(
    "options",
    [
        {"process_exit": 7},
        {"case_status": "pending"},
        {"case_status": "skipped"},
        {"case_status": "failed"},
        {"empty_cases": True},
        {"report_name": "similarlyNamedSample"},
    ],
)
def test_vitest_batch_retains_process_selection_and_nonempty_pass_guards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, options: dict[str, Any]
) -> None:
    rows, _, logs = vitest_batch(tmp_path, monkeypatch, **options)
    tool()._batch_tests(tmp_path, "vitest", rows, logs, {})
    assert rows[0]["status"] == "FAIL" and rows[0]["exit_status"] != 0
    assert rows[0]["runner_process_exit"] == options.get("process_exit", 0)


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "--quiet", "--template=")
    (root / ".gitignore").write_text(".tmp/\n", encoding="utf-8")
    return root


def files(root: Path, rows: dict[str, str], newline: str = "\n") -> None:
    for name, text in rows.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.replace("\n", newline).encode("utf-8"))
    git(root, "add", ".")


def commit(root: Path, subject: str = "fixture") -> str:
    git(
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        subject,
    )
    return git(root, "rev-parse", "HEAD")


def _recorded_source_commit_resolves(root: Path) -> bool:
    record = json.loads(
        (root / "comfyui_h3_context/contracts/build_provenance_v1.json").read_bytes()
    )
    commit = record["external_parameters"]["source_commit"]
    probe = subprocess.run(
        ["git", "-C", str(root), "cat-file", "-e", f"{commit}^{{commit}}"],
        capture_output=True,
        check=False,
    )
    return probe.returncode == 0


def test_identity_drift_uses_real_read_only_validator_clis(tmp_path: Path) -> None:
    artifacts = [
        ROOT / "comfyui_h3_context/contracts/build_provenance_v1.json",
        ROOT / "governance/contracts/supply_chain_v1.json",
    ]
    before = [path.read_bytes() for path in artifacts]
    valid, checks = tool()._identity_drift_checks(
        ROOT, Path(sys.executable), tmp_path, dict(os.environ)
    )
    assert len(checks) == 2
    assert all(Path(row["log"]).is_file() for row in checks)
    assert [path.read_bytes() for path in artifacts] == before
    if _recorded_source_commit_resolves(ROOT):
        assert valid
        assert all(row["exit_status"] == 0 for row in checks)
        return
    # CRITICAL: the provenance record names a private development commit, and a public checkout
    # never holds that history, so `build_provenance.py --check` must refuse there at any clone
    # depth. Decide this case from Git, never from a platform or an environment variable, and do
    # not skip it: both validators must still run, and the supply validator must still pass. The
    # development check of the record is the Full Gate's own `build_provenance.py --check` step.
    by_script = {Path(row["command"][4]).stem: row for row in checks}
    assert not valid
    assert by_script["supply_chain_manifest"]["exit_status"] == 0
    assert by_script["build_provenance"]["exit_status"] != 0
    refusal = Path(by_script["build_provenance"]["log"]).read_text(encoding="utf-8")
    assert refusal.startswith("BUILD PROVENANCE: FAIL: ")


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_cross_runner_helper_reexports_and_exact_names(repo: Path, newline: str) -> None:
    files(
        repo,
        {
            "frontend/e2e/source.ts": "export const source = 1;\n",
            "frontend/e2e/index.ts": 'export { source } from "./source.js";\n',
            "frontend/tests/nleMediaRebind.test.ts": 'import { source } from "../e2e/index";\n',
            "frontend/tests/e2e/helpers/media.ts": 'export * from "../../../e2e/index";\n',
            "frontend/tests/e2e/journeys/media.spec.ts": 'import "../helpers/media";\n',
            "frontend/tests/unrelated.test.ts": (
                '// import "../e2e/source";\nconst label = "source.ts";\n'
            ),
            "frontend/playwright.config.ts": (
                'export default { testMatch: ["journeys/media.spec.ts"] };\n'
            ),
        },
        newline,
    )
    selected = tool().select_tests(repo, ["frontend/e2e/source.ts"], typescript_root=ROOT)
    by_path = {row["test"]: row for row in selected}
    assert "frontend/tests/nleMediaRebind.test.ts" in by_path
    assert "frontend/tests/e2e/journeys/media.spec.ts" in by_path
    assert "frontend/tests/unrelated.test.ts" not in by_path
    assert any(
        reason["chain"]
        == [
            "frontend/e2e/source.ts",
            "frontend/e2e/index.ts",
            "frontend/tests/nleMediaRebind.test.ts",
        ]
        for reason in by_path["frontend/tests/nleMediaRebind.test.ts"]["reasons"]
    )


def test_typescript_dynamic_import_is_not_a_string_or_comment_search(repo: Path) -> None:
    files(
        repo,
        {
            "frontend/e2e/source.ts": "export const value = 1;",
            "frontend/tests/dynamic.test.ts": 'const load = () => import("../e2e/source.js");',
            "frontend/tests/text.test.ts": 'const text = "import(\\"../e2e/source.js\\")";',
        },
    )
    selected = tool().select_tests(repo, ["frontend/e2e/source.ts"], typescript_root=ROOT)
    assert {row["test"] for row in selected if row["runner"] == "vitest"} == {
        "frontend/tests/dynamic.test.ts"
    }


def test_python_relative_reexports_and_literal_dynamic_imports(repo: Path) -> None:
    files(
        repo,
        {
            "scripts/pkg/__init__.py": "from .helper import value\n",
            "scripts/pkg/helper.py": "from . import source\nvalue = source.value\n",
            "scripts/pkg/source.py": "value = 1\n",
            "tests/test_one.py": "from scripts.pkg import value\n",
            "tests/test_two.py": (
                'import importlib\nmodule = importlib.import_module("scripts.pkg.source")\n'
            ),
            "tests/test_unrelated.py": 'text = "scripts.pkg.source"\n',
        },
    )
    selected = tool().select_tests(repo, ["scripts/pkg/source.py"])
    tests = {
        row["test"]
        for row in selected
        if any(reason["rule"] == "python-import" for reason in row["reasons"])
    }
    assert tests == {"tests/test_one.py", "tests/test_two.py"}


def test_text_change_selects_security_without_importer(repo: Path) -> None:
    files(repo, {"frontend/tests/e2e/journeys/new.spec.ts": "export {};\n"})
    selected = tool().select_tests(
        repo, ["frontend/tests/e2e/journeys/new.spec.ts"], typescript_root=ROOT
    )
    audit = next(row for row in selected if row["test"] == "tests/test_security_audit.py")
    assert audit["runner"] == "pytest"
    assert {reason["rule"] for reason in audit["reasons"]} == {"guard:text"}


@pytest.mark.parametrize(
    ("path", "guard"),
    [
        ("scripts/generator.py", "tests/test_m23_48_derived_artifacts.py"),
        ("frontend/src/host/owner.ts", "tests/test_frontend_module_budget.py"),
        ("frontend/src/view.ts", "tests/test_architecture_fitness.py"),
        ("comfyui_h3_context/web/h3-context-sidebar.js", "tests/test_frontend_build_report.py"),
        ("governance/contracts/supply_chain_v1.json", "tests/test_supply_chain_manifest.py"),
        (
            "requirements/secret-scan-baseline.json",
            "tests/test_tooling_contract.py::ToolingContractTests::test_secret_baseline_is_valid_and_closed_to_reviewed_public_literals",
        ),
    ],
)
def test_guard_input_types(repo: Path, path: str, guard: str) -> None:
    files(repo, {path: 'parser.add_argument("--write")\n' if path.endswith(".py") else "{}\n"})
    selected = tool().select_tests(repo, [path], typescript_root=ROOT)
    assert guard in {row["test"] for row in selected}


def test_binary_change_does_not_invent_text_guard(repo: Path) -> None:
    target = repo / "sample.bin"
    target.write_bytes(b"\x00\xff\x00")
    git(repo, "add", ".")
    assert tool().select_tests(repo, ["sample.bin"]) == []


def passed_receipt(head: str, tree: str) -> dict[str, object]:
    components = [
        dict(
            id="pytest:tests/test_example.py",
            runner="pytest",
            test="tests/test_example.py",
            reasons=[dict(rule="changed-test", chain=["tests/test_example.py"])],
            command=["python", "-m", "pytest", "tests/test_example.py"],
            exit_status=0,
            status="PASS",
        ),
        dict(
            id="pre_commit",
            runner="pre_commit",
            test=None,
            reasons=[dict(rule="changed-paths", chain=[])],
            command=["python", "-m", "pre_commit"],
            exit_status=0,
            status="PASS",
        ),
        dict(
            id="derived",
            runner="derived",
            test=None,
            reasons=[dict(rule="derived-dry-run", chain=[])],
            command=["python", "scripts/derived_artifacts.py", "dry-run"],
            exit_status=0,
            status="PASS",
        ),
    ]
    return dict(
        schema="h3-context-repair-prefreeze/1",
        base=head,
        head=head,
        tree=tree,
        changed_paths=["tests/test_example.py"],
        methods=dict(
            vitest="typescript-import", playwright="typescript-import", pytest="python-ast+guards"
        ),
        counts=dict(vitest=0, playwright=0, pytest=1),
        components=components,
        status="PASS",
    )


@pytest.mark.parametrize(
    ("variant", "expected"),
    [("missing", 10), ("failed", 11), ("other-head", 12), ("invalid", 13), ("valid", 0)],
)
def test_verify_read_only_named_refusals(repo: Path, variant: str, expected: int) -> None:
    files(repo, {"value.py": "value = 1\n"})
    head = commit(repo)
    tree = git(repo, "rev-parse", "HEAD^{tree}")
    receipt_path = repo / ".tmp/receipt.json"
    receipt_path.parent.mkdir()
    receipt = passed_receipt(head, tree)
    if variant == "failed":
        receipt["status"] = "FAIL"
        receipt["components"][0]["status"] = "FAIL"  # type: ignore[index]
        receipt["components"][0]["exit_status"] = 1  # type: ignore[index]
    elif variant == "other-head":
        receipt["head"] = "0" * 40
    elif variant == "invalid":
        receipt["counts"] = dict(vitest=0, playwright=0, pytest=0)
    if variant != "missing":
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
    before = {
        path.relative_to(repo).as_posix(): path.read_bytes()
        for path in repo.rglob("*")
        if path.is_file()
    }
    assert (
        tool().main(["verify", "--root", str(repo), "--head", head, "--receipt", str(receipt_path)])
        == expected
    )
    after = {
        path.relative_to(repo).as_posix(): path.read_bytes()
        for path in repo.rglob("*")
        if path.is_file()
    }
    assert after == before


def test_false_pass_receipt_cannot_hide_failed_component(repo: Path) -> None:
    files(repo, {"value.py": "value = 1\n"})
    head = commit(repo)
    receipt = passed_receipt(head, git(repo, "rev-parse", "HEAD^{tree}"))
    receipt["components"][0]["exit_status"] = 1  # type: ignore[index]
    with pytest.raises(tool().Refusal):
        tool().validate_receipt(receipt, head, receipt["tree"])


def test_receipt_location_cannot_be_tracked_or_escape(repo: Path) -> None:
    files(repo, {"value.py": "value = 1\n"})
    commit(repo)
    with pytest.raises(tool().Refusal):
        tool().receipt_location(repo, repo / "value.py")
    with pytest.raises(tool().Refusal):
        tool().receipt_location(repo, repo.parent / "outside.json")


def test_changed_paths_preserve_both_rename_endpoints(repo: Path) -> None:
    files(repo, {"old.py": "value = 1\n"})
    base = commit(repo)
    git(repo, "mv", "old.py", "new.py")
    head = commit(repo, "rename")
    assert tool().changed_paths(repo, base, head) == ["new.py", "old.py"]


def test_unresolved_local_import_refuses_instead_of_dropping_edge(repo: Path) -> None:
    files(
        repo,
        {
            "frontend/e2e/source.ts": 'export * from "./missing";',
            "frontend/tests/one.test.ts": 'import "../e2e/source";',
        },
    )
    with pytest.raises(tool().Refusal, match="local_import_unresolved"):
        tool().select_tests(repo, ["frontend/e2e/source.ts"], typescript_root=ROOT)


def test_templates_and_regex_keep_import_graph_context(repo: Path) -> None:
    files(
        repo,
        {
            "frontend/e2e/source.ts": "export const value = 1;",
            "frontend/tests/template.test.ts": r"""
const css = `.panel { color: #0d0f13; } ${String(1)}\n#after { display: block; }`;
const fake = `import("../e2e/missing.js")`;
const pattern = /import\("\.\.\/e2e\/missing.js"\)/;
import { value } from "../e2e/source.js";
""",
        },
    )
    selected = tool().select_tests(repo, ["frontend/e2e/source.ts"], typescript_root=ROOT)
    assert {row["test"] for row in selected if row["runner"] == "vitest"} == {
        "frontend/tests/template.test.ts"
    }


@pytest.mark.parametrize(
    "config", ["playwright.config", "playwright.hc09.config", "playwright.hc10.config"]
)
def test_dotted_config_specifiers_get_module_extensions(repo: Path, config: str) -> None:
    hardening = (ROOT / "frontend/playwright.hardening.config.ts").read_text(encoding="utf-8")
    files(
        repo,
        {
            f"frontend/{config}.ts": "export default {};",
            "frontend/playwright.hardening.config.ts": hardening.replace(
                '"./playwright.config"', f'"./{config}"'
            ),
            "frontend/tests/config.test.ts": 'import "../playwright.hardening.config";',
        },
    )
    selected = tool().select_tests(repo, [f"frontend/{config}.ts"], typescript_root=ROOT)
    row = next(row for row in selected if row["test"] == "frontend/tests/config.test.ts")
    assert any(
        reason["chain"]
        == [
            f"frontend/{config}.ts",
            "frontend/playwright.hardening.config.ts",
            "frontend/tests/config.test.ts",
        ]
        for reason in row["reasons"]
    )


def alias_fixture(repo: Path) -> None:
    files(
        repo,
        {
            "frontend/src/entry.tsx": 'import { app } from "../../scripts/app.js";',
            "frontend/tests/fixtures/entryHostModules.ts": "export const app = {};",
            "frontend/tests/fixtures/browserHostModules.ts": "export const app = {};",
            "frontend/tests/entry.test.ts": 'import "../src/entry";',
            "frontend/tests/e2e/journeys/entry.spec.ts": 'import "../../../src/entry";',
            "frontend/vitest.config.ts": (
                'export default { resolve: { alias: { "../../scripts/app.js": '
                'fileURLToPath(new URL("./tests/fixtures/entryHostModules.ts", '
                "import.meta.url)) } } };"
            ),
            "frontend/vite.e2e.config.ts": (
                'export default { resolve: { alias: { "../../scripts/app.js": '
                'fileURLToPath(new URL("./tests/fixtures/browserHostModules.ts", '
                "import.meta.url)) } } };"
            ),
            "frontend/vite.config.ts": (
                "export default { build: { rolldownOptions: { "
                'external: ["../../scripts/app.js"] } } };'
            ),
        },
    )


def test_host_fixture_aliases_are_exact_and_runner_specific(repo: Path) -> None:
    alias_fixture(repo)
    for fixture, expected in [
        ("entryHostModules", "frontend/tests/entry.test.ts"),
        ("browserHostModules", "frontend/tests/e2e/journeys/entry.spec.ts"),
    ]:
        selected = tool().select_tests(
            repo, [f"frontend/tests/fixtures/{fixture}.ts"], typescript_root=ROOT
        )
        tests = {row["test"] for row in selected if row["runner"] in {"vitest", "playwright"}}
        assert tests == {expected}
        row = next(row for row in selected if row["test"] == expected)
        assert any(reason["chain"][1] == "frontend/src/entry.tsx" for reason in row["reasons"])


def test_declared_production_host_external_is_recorded(repo: Path) -> None:
    alias_fixture(repo)
    analysis: dict[str, object] = {}
    tool().select_tests(repo, ["frontend/src/entry.tsx"], typescript_root=ROOT, analysis=analysis)
    assert analysis["external_modules"] == [
        dict(
            runner="production",
            importer="frontend/src/entry.tsx",
            specifier="../../scripts/app.js",
            rule="declared-external",
        )
    ]
    assert analysis["limits"] == dict(
        node_heap_mib=768, parser_timeout_seconds=60, windows_job_memory_mib=2048
    )


@pytest.mark.parametrize(
    ("limit", "value", "name", "code"),
    [
        ("PARSER_TIMEOUT_SECONDS", 0.001, "typescript_parser_timeout", 15),
        ("PARSER_HEAP_MIB", 8, "typescript_parser_memory_limit", 16),
    ],
)
def test_real_parser_limits_refuse_with_named_exit(
    repo: Path, monkeypatch: pytest.MonkeyPatch, limit: str, value: float, name: str, code: int
) -> None:
    source = "export {};"
    if limit == "PARSER_HEAP_MIB":
        source = "".join(f"export const bound{index} = {index};\n" for index in range(10000))
    files(repo, {"frontend/tests/small.test.ts": source})
    if limit == "PARSER_HEAP_MIB":
        selected = tool().select_tests(repo, ["frontend/tests/small.test.ts"], typescript_root=ROOT)
        assert any(row["test"] == "frontend/tests/small.test.ts" for row in selected)
    monkeypatch.setattr(tool(), limit, value)
    with pytest.raises(tool().Refusal, match=name) as caught:
        tool().select_tests(repo, ["frontend/tests/small.test.ts"], typescript_root=ROOT)
    assert caught.value.code == code


def browser_row(name: str) -> dict[str, Any]:
    path = "frontend/tests/e2e/journeys/" + name + ".spec.ts"
    return dict(
        id="playwright:" + path,
        runner="playwright",
        test=path,
        reasons=[dict(rule="fixture", chain=[path])],
    )


def test_real_output_groups_have_fresh_relay_and_retained_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows = [
        browser_row(name)
        for name in (
            "plain",
            "integratedEditorAcceptance",
            "nleServiceLoopback",
            "m25_77ClipAudioParity",
        )
    ]
    logs = tmp_path / ".tmp/logs"
    logs.mkdir(parents=True)
    calls: list[tuple[list[str], dict[str, str]]] = []
    artifacts: list[Path] = []

    def batch(
        root: Path,
        runner: str,
        members: list[dict[str, Any]],
        group_logs: Path,
        env: dict[str, str],
    ) -> None:
        destination = Path(env.get("H3_CONTEXT_PLAYWRIGHT_OUTPUT", "missing"))
        assert destination.is_absolute() and destination.parent == group_logs
        assert not destination.exists()
        for previous in artifacts:
            assert (previous / "sentinel.txt").read_text() == "retained"
        destination.mkdir()
        (destination / "sentinel.txt").write_text("retained")
        artifacts.append(destination)
        calls.append(([row["test"] for row in members], dict(env)))
        for row in members:
            row.update(
                command=["node", "fixture"],
                log=str(group_logs),
                exit_status=0,
                runner_process_exit=0,
                cases=1,
                status="PASS",
            )

    monkeypatch.setattr(tool(), "_batch_tests", batch)
    inherited = dict(
        H3_CONTEXT_E2E_OUTPUT_RELAY_DIR="foreign-relay",
        H3_CONTEXT_E2E_PYTHON="foreign-python",
        H3_CONTEXT_E2E_SERVICE_LOOPBACK="inherited",
        H3_CONTEXT_PLAYWRIGHT_OUTPUT="foreign-artifacts",
    )
    groups = tool()._run_browser_groups(tmp_path, rows, logs, inherited)
    assert all(group["status"] == "PASS" for group in groups)
    assert [len(paths) for paths, _ in calls] == [1, 2, 1]
    assert len(set(artifacts)) == 3
    for paths, env in calls:
        real_output = "integratedEditorAcceptance" in paths[0]
        relay = env.get("H3_CONTEXT_E2E_OUTPUT_RELAY_DIR")
        if real_output:
            assert relay and Path(relay).is_dir()
            Path(relay).resolve().relative_to(tmp_path / ".tmp")
            assert not list(Path(relay).iterdir())
            assert "H3_CONTEXT_E2E_PYTHON" not in env
        else:
            assert relay is None
            if "nleServiceLoopback" not in paths[0]:
                assert "H3_CONTEXT_E2E_PYTHON" not in env
    assert inherited["H3_CONTEXT_E2E_OUTPUT_RELAY_DIR"] == "foreign-relay"


def test_browser_artifact_collision_refuses_before_launch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    artifact = tmp_path / "artifacts"
    artifact.mkdir()
    (artifact / "sentinel.txt").write_text("retained")
    monkeypatch.setattr(tool(), "_batch_tests", lambda *args: pytest.fail("launched stale output"))
    with pytest.raises(tool().Refusal, match="browser_artifacts_already_exists"):
        tool()._run_browser_groups(tmp_path, [browser_row("plain")], tmp_path, {})
    assert (artifact / "sentinel.txt").read_text() == "retained"


def test_pytest_basetemp_is_fresh_across_equal_receipt_stems(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = tool()
    python = tmp_path / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    python.parent.mkdir(parents=True)
    python.touch()
    monkeypatch.setattr(module.sys, "executable", str(python))
    monkeypatch.setattr(module, "git", lambda root, *args: "" if "diff" in args else "1" * 40)
    monkeypatch.setattr(module, "changed_paths", lambda *args: [])
    temps: list[Path] = []

    def execute(
        root: Path, command: list[str], log: Path, env: dict[str, str]
    ) -> subprocess.CompletedProcess[str]:
        if "pytest" in command:
            temp = root / next(
                arg.split("=", 1)[1] for arg in command if arg.startswith("--basetemp=")
            )
            assert not temp.exists()
            temp.mkdir(parents=True)
            temps.append(temp)
            return subprocess.CompletedProcess(command, 0, "1 passed", "")
        return subprocess.CompletedProcess(
            command, 0, json.dumps(dict(outputs=[], bundle_rebuild_reasons=[])), ""
        )

    monkeypatch.setattr(module, "_execute", execute)
    selected = [
        dict(id="pytest:tests/sample.py", runner="pytest", test="tests/sample.py", reasons=[])
    ]
    for parent in ("first", "second"):
        result = module.run_checks(
            tmp_path, "0" * 40, "1" * 40, tmp_path / parent / "same.json", selected
        )
        assert result["components"][0]["status"] == "PASS"
    assert len(temps) == len(set(temps)) == 2
    assert all(path.is_dir() for path in temps)


def test_browser_precondition_table_matches_every_configured_spec_guard() -> None:
    guards = tool().browser_skip_guards(ROOT, ROOT)
    declared = {
        name: set(values) - {"H3_CONTEXT_E2E_PYTHON"}
        for name, values in tool().BROWSER_PRECONDITIONS.items()
        if "H3_CONTEXT_E2E_OUTPUT_RELAY_DIR" not in values
    }
    declared.update(tool().BROWSER_SHARED_GUARDS)
    assert {name: set(values) for name, values in guards.items() if values} == declared


def test_skip_guard_parser_follows_conditions_and_ignores_strings(repo: Path) -> None:
    path = "frontend/tests/e2e/journeys/new.spec.ts"
    files(
        repo,
        {
            path: """
const allowed = process.env["H3_CONTEXT_E2E_NEW_OPT_IN"] === "1";
const title = "process.env.NOT_A_GUARD";
// test.skip(process.env.COMMENT_ONLY !== "1");
test.skip(!allowed, title);
if (!process.env.H3_CONTEXT_E2E_OTHER_OPT_IN) { test.skip(true, "guarded"); }
""",
            "frontend/playwright.config.ts": (
                'export default {testMatch: ["journeys/new.spec.ts"]};'
            ),
        },
    )
    assert tool().browser_skip_guards(repo, ROOT) == {
        path: ["H3_CONTEXT_E2E_NEW_OPT_IN", "H3_CONTEXT_E2E_OTHER_OPT_IN"]
    }


@pytest.mark.parametrize(
    "names,expected",
    [
        (["plain", "other"], [["plain", "other"]]),
        (
            ["plain", "nleServiceLoopback", "other", "realMediaSourceLeases"],
            [["plain", "other"], ["nleServiceLoopback"], ["realMediaSourceLeases"]],
        ),
        (
            ["plain", "integratedEditorAcceptance", "m25_77ClipAudioParity"],
            [["plain"], ["integratedEditorAcceptance", "m25_77ClipAudioParity"]],
        ),
        (["realMediaSourceLeases"], [["realMediaSourceLeases"]]),
    ],
)
def test_browser_groups_run_sequentially_with_isolated_flags_and_truthful_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, names: list[str], expected: list[list[str]]
) -> None:
    rows = [browser_row(name) for name in names]
    env = dict(
        H3_CONTEXT_E2E_SERVICE_LOOPBACK="inherited",
        H3_CONTEXT_E2E_SERVICE_LOOPBACK_MEDIA="inherited",
        H3_CONTEXT_AUTHORIZED_FFMPEG_PATH="qualified-pair",
        H3_CONTEXT_E2E_OUTPUT_RELAY_DIR="fresh-relay",
    )
    before = dict(env)
    calls = []

    def batch(
        root: Path,
        runner: str,
        group: list[dict[str, Any]],
        logs: Path,
        group_env: dict[str, str],
    ) -> None:
        assert runner == "playwright"
        calls.append(([row["test"] for row in group], dict(group_env)))
        for row in group:
            row.update(
                command=["node", "fixture"],
                log=str(logs),
                exit_status=0,
                runner_process_exit=0,
                cases=2,
                status="PASS",
            )

    monkeypatch.setattr(tool(), "_batch_tests", batch)
    groups = tool()._run_browser_groups(tmp_path, rows, tmp_path, env)
    assert [
        [Path(name).stem.removesuffix(".spec") for name in paths] for paths, _ in calls
    ] == expected
    assert env == before
    assert len(groups) == len(calls)
    for (paths, actual_env), group in zip(calls, groups, strict=True):
        service = any(
            "nleServiceLoopback" in path or "realMediaSourceLeases" in path for path in paths
        )
        media = any("realMediaSourceLeases" in path for path in paths)
        assert actual_env.get("H3_CONTEXT_E2E_SERVICE_LOOPBACK") == ("1" if service else None)
        assert actual_env.get("H3_CONTEXT_E2E_SERVICE_LOOPBACK_MEDIA") == ("1" if media else None)
        assert actual_env.get("H3_CONTEXT_E2E_PYTHON") == (
            str(tmp_path / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python"))
            if service
            else None
        )
        assert actual_env["H3_CONTEXT_AUTHORIZED_FFMPEG_PATH"] == "qualified-pair"
        relay = any(
            "integratedEditorAcceptance" in path or "m25_77ClipAudioParity" in path
            for path in paths
        )
        if relay:
            assert Path(actual_env["H3_CONTEXT_E2E_OUTPUT_RELAY_DIR"]).is_dir()
        else:
            assert "H3_CONTEXT_E2E_OUTPUT_RELAY_DIR" not in actual_env
        assert group["specs"] == paths and group["status"] == "PASS"
        assert group["cases"] == 2 * len(paths) and group["exit_status"] == 0
        assert set(group["environment_names"]) == (
            {"H3_CONTEXT_E2E_SERVICE_LOOPBACK", "H3_CONTEXT_E2E_PYTHON"}
            | ({"H3_CONTEXT_E2E_SERVICE_LOOPBACK_MEDIA"} if media else set())
            if service
            else ({"H3_CONTEXT_E2E_OUTPUT_RELAY_DIR"} if relay else set())
        )
        assert "qualified-pair" not in json.dumps(group) and "fresh-relay" not in json.dumps(group)


def fake_browser_report(rows: list[dict[str, Any]], status: str = "passed") -> dict[str, Any]:
    return dict(
        errors=[],
        suites=[
            dict(
                specs=[
                    dict(
                        file=str(row["test"]).removeprefix("frontend/tests/e2e/"),
                        tests=[
                            dict(
                                expectedStatus="skipped" if status == "skipped" else "passed",
                                status="skipped" if status == "skipped" else "expected",
                                results=[dict(status=status, retry=0)],
                            )
                        ],
                    )
                    for row in rows
                ]
            )
        ],
    )


def test_default_group_preserves_exact_selection_without_inherited_relay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows = [browser_row("plain"), browser_row("other")]
    env = dict(H3_CONTEXT_E2E_PORT="4431", H3_CONTEXT_E2E_OUTPUT_RELAY_DIR="fresh")
    invocations = []
    monkeypatch.setattr(tool(), "_node_cli", lambda *args: ["node", "playwright-cli"])
    monkeypatch.setattr(tool(), "_browser_preflight", lambda *args: None)

    def execute(
        cwd: Path, command: list[str], log: Path, actual_env: dict[str, str]
    ) -> subprocess.CompletedProcess[str]:
        invocations.append((cwd, command, log, actual_env))
        return subprocess.CompletedProcess(command, 0, json.dumps(fake_browser_report(rows)), "")

    monkeypatch.setattr(tool(), "_execute", execute)
    groups = tool()._run_browser_groups(tmp_path, rows, tmp_path, env)
    old_argv = [
        "node",
        "playwright-cli",
        "test",
        *[
            "^" + re.escape((tmp_path / str(row["test"])).as_posix()).replace("/", r"[/\\]") + "$"
            for row in rows
        ],
        "--workers",
        "2",
        "--retries",
        "0",
        "--reporter=json",
    ]
    expected_env = dict(
        H3_CONTEXT_E2E_PORT="4431", H3_CONTEXT_PLAYWRIGHT_OUTPUT=str(tmp_path / "artifacts")
    )
    assert invocations == [
        (tmp_path / "frontend", old_argv, tmp_path / "playwright.txt", expected_env)
    ]
    assert groups[0]["specs"] == [row["test"] for row in rows]
    assert groups[0]["environment_names"] == []


def test_browser_groups_still_refuse_skipped_cases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows = [browser_row("realMediaSourceLeases")]
    monkeypatch.setattr(tool(), "_node_cli", lambda *args: ["node", "playwright-cli"])
    monkeypatch.setattr(tool(), "_browser_preflight", lambda *args: None)
    monkeypatch.setattr(
        tool(),
        "_execute",
        lambda cwd, command, log, env: subprocess.CompletedProcess(
            command, 0, json.dumps(fake_browser_report(rows, "skipped")), ""
        ),
    )
    groups = tool()._run_browser_groups(tmp_path, rows, tmp_path, {})
    assert rows[0]["status"] == groups[0]["status"] == "FAIL"
    assert groups[0]["exit_status"] != 0


def test_group_receipt_validation_refuses_unaccounted_or_false_pass_group() -> None:
    receipt = passed_receipt("1" * 40, "2" * 40)
    receipt["browser_groups"] = [
        dict(
            specs=["frontend/tests/e2e/journeys/lost.spec.ts"],
            environment_names=[],
            command=["node", "fixture"],
            log=".tmp/reporter.txt",
            exit_status=0,
            status="PASS",
            cases=1,
            runner_process_exit=0,
        )
    ]
    with pytest.raises(tool().Refusal, match="receipt_invalid"):
        tool().validate_receipt(receipt, receipt["head"], receipt["tree"])


@pytest.mark.parametrize(
    "corruption", [None, "environment", "membership", "status", "count", "log"]
)
def test_optional_group_evidence_is_validated_without_breaking_old_receipts(
    corruption: str | None,
) -> None:
    receipt: Any = passed_receipt("1" * 40, "2" * 40)
    row = browser_row("plain")
    row.update(
        command=["node", "fixture"],
        log=".tmp/reporter.txt",
        cases=1,
        exit_status=0,
        status="PASS",
        runner_process_exit=0,
    )
    receipt["components"].append(row)
    receipt["counts"]["playwright"] = 1
    group: dict[str, Any] = dict(
        specs=[row["test"]],
        environment_names=[],
        command=row["command"],
        log=row["log"],
        cases=1,
        exit_status=0,
        status="PASS",
        runner_process_exit=0,
    )
    receipt["browser_groups"] = [group]
    if corruption == "environment":
        group["environment_names"] = ["H3_CONTEXT_E2E_SERVICE_LOOPBACK"]
    elif corruption == "membership":
        group["specs"] *= 2
    elif corruption == "status":
        group["status"] = "FAIL"
    elif corruption == "count":
        group["cases"] = 2
    elif corruption == "log":
        group["log"] = ".tmp/other.txt"
    if corruption:
        with pytest.raises(tool().Refusal, match="receipt_invalid"):
            tool().validate_receipt(receipt, receipt["head"], receipt["tree"])
    else:
        tool().validate_receipt(receipt, receipt["head"], receipt["tree"])
