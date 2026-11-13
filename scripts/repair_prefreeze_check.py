"""Select and execute affected repair checks; verify a receipt before a release freeze.

Receipts and runner logs belong in ignored workspace storage, never in the public tree.
The verify mode reads only its receipt and Git; it never launches a validation command.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from collections import deque
from collections.abc import Sequence
from fnmatch import fnmatchcase
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "h3-context-repair-prefreeze/1"
RUNNERS = ("vitest", "playwright", "pytest")
CODE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"}
PARSER_HEAP_MIB = 768
PARSER_TIMEOUT_SECONDS = 60
PARSER_JOB_MEMORY_MIB = 2048
GRAPH_EXCLUSIONS = {
    "comfyui_h3_context/web/h3-context-sidebar.js": (
        "generated leaf output; selected by bundle/input-type guards, with no source importer"
    ),
}
BROWSER_PRECONDITIONS = {
    "frontend/tests/e2e/journeys/integratedEditorAcceptance.spec.ts": {
        "H3_CONTEXT_E2E_OUTPUT_RELAY_DIR": "target-output-relay",
    },
    "frontend/tests/e2e/journeys/m25_77ClipAudioParity.spec.ts": {
        "H3_CONTEXT_E2E_OUTPUT_RELAY_DIR": "target-output-relay",
    },
    "frontend/tests/e2e/journeys/nleServiceLoopback.spec.ts": {
        "H3_CONTEXT_E2E_SERVICE_LOOPBACK": "1",
        "H3_CONTEXT_E2E_PYTHON": "target-python",
    },
    "frontend/tests/e2e/journeys/realMediaSourceLeases.spec.ts": {
        "H3_CONTEXT_E2E_SERVICE_LOOPBACK": "1",
        "H3_CONTEXT_E2E_SERVICE_LOOPBACK_MEDIA": "1",
        "H3_CONTEXT_E2E_PYTHON": "target-python",
    },
}
# This guard consumes the qualified decoder already shared by all groups; it enables no service.
BROWSER_SHARED_GUARDS = {
    "frontend/tests/e2e/journeys/mediaSourceLeases.spec.ts": {"H3_CONTEXT_AUTHORIZED_FFMPEG_PATH"},
}


def parser_limits() -> dict[str, int]:
    return dict(
        node_heap_mib=PARSER_HEAP_MIB,
        parser_timeout_seconds=PARSER_TIMEOUT_SECONDS,
        windows_job_memory_mib=PARSER_JOB_MEMORY_MIB,
    )


class Refusal(Exception):
    def __init__(self, name: str, code: int = 14) -> None:
        super().__init__(name)
        self.code = code


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True)
    if result.returncode:
        raise Refusal("git_input_unavailable")
    return result.stdout.decode("utf-8", errors="strict").strip()


def revision(root: Path, value: str) -> str:
    if value.startswith("-"):
        raise Refusal("invalid_revision")
    return git(root, "rev-parse", "--verify", f"{value}^{{commit}}")


def safe_name(name: str) -> str:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or not path.parts:
        raise Refusal("escaping_repository_path")
    return path.as_posix()


def changed_paths(root: Path, base: str, head: str) -> list[str]:
    # IMPORTANT: both rename endpoints and deleted modules are seeds. Keeping only the new
    # spelling loses importers still referring to the removed module during a repair.
    fields = git(root, "diff", "--name-status", "-z", "--find-renames", base, head, "--").split(
        "\0"
    )
    result: set[str] = set()
    index = 0
    while index < len(fields) and fields[index]:
        status = fields[index]
        index += 1
        count = 2 if status[0] in {"R", "C"} else 1
        for name in fields[index : index + count]:
            result.add(safe_name(name))
        index += count
    return sorted(result)


def _python_graph(root: Path, known: set[str]) -> dict[str, set[str]]:
    paths = {name for name in known if name.endswith(".py")}
    modules = {
        name.removesuffix(".py").removesuffix("/__init__").replace("/", "."): name for name in paths
    }
    graph: dict[str, set[str]] = {}
    for name in sorted(paths):
        if not (root / name).is_file():
            continue
        try:
            tree = ast.parse((root / name).read_bytes(), filename=name)
        except (SyntaxError, UnicodeError) as error:
            raise Refusal(f"python_import_parse_failed:{name}") from error
        package = name.removesuffix(".py").replace("/", ".")
        package = (
            package.removesuffix(".__init__")
            if name.endswith("/__init__.py")
            else package.rpartition(".")[0]
        )
        imports: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                target = node.module or ""
                if node.level:
                    try:
                        target = importlib.util.resolve_name("." * node.level + target, package)
                    except (ImportError, ValueError) as error:
                        raise Refusal(f"python_relative_import_unresolved:{name}") from error
                imports.add(target)
                imports.update(
                    f"{target}.{alias.name}" for alias in node.names if alias.name != "*"
                )
            elif isinstance(node, ast.Call):
                called = (
                    node.func.attr
                    if isinstance(node.func, ast.Attribute)
                    else getattr(node.func, "id", "")
                )
                if (
                    called in {"import_module", "__import__"}
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)
                ):
                    target = node.args[0].value
                    if not target.startswith("."):
                        imports.add(target)
        edges: set[str] = set()
        for target in imports:
            parts = target.split(".")
            for end in range(1, len(parts) + 1):
                if (resolved := modules.get(".".join(parts[:end]))) is not None:
                    edges.add(resolved)
        graph[name] = edges - {name}
    return graph


def _parser_job(process: subprocess.Popen[str]) -> tuple[Any, Any]:
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_int64),
            ("job_time", ctypes.c_int64),
            ("flags", wintypes.DWORD),
            ("minimum", ctypes.c_size_t),
            ("maximum", ctypes.c_size_t),
            ("processes", wintypes.DWORD),
            ("affinity", ctypes.c_size_t),
            ("priority", wintypes.DWORD),
            ("scheduling", wintypes.DWORD),
        ]

    class Limits(ctypes.Structure):
        _fields_ = [
            ("basic", Basic),
            ("io", ctypes.c_uint64 * 6),
            ("process_memory", ctypes.c_size_t),
            ("job_memory", ctypes.c_size_t),
            ("peak_process", ctypes.c_size_t),
            ("peak_job", ctypes.c_size_t),
        ]

    kernel = getattr(ctypes, "WinDLL")("kernel32", use_last_error=True)  # noqa: B009
    signatures = {
        "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        "SetInformationJobObject": (
            [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD],
            wintypes.BOOL,
        ),
        "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = arguments, result
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise Refusal("typescript_parser_containment_failed")
    limits = Limits()
    limits.basic.flags = 0x2200  # kill-on-close and aggregate job memory
    limits.job_memory = PARSER_JOB_MEMORY_MIB * 1024 * 1024
    if not kernel.SetInformationJobObject(
        handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
    ) or not kernel.AssignProcessToJobObject(handle, int(getattr(process, "_handle"))):  # noqa: B009
        kernel.CloseHandle(handle)
        raise Refusal("typescript_parser_containment_failed")
    return kernel, handle


def _parser_run(root: Path, request: dict[str, Any]) -> subprocess.CompletedProcess[str]:
    command = [
        "node",
        f"--max-old-space-size={PARSER_HEAP_MIB}",
        str(ROOT / "scripts/repair_import_graph.mjs"),
    ]
    env = dict(os.environ)
    env.pop("NODE_OPTIONS", None)
    env["GOMEMLIMIT"] = f"{PARSER_HEAP_MIB}MiB"
    process = subprocess.Popen(
        command,
        cwd=root,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        start_new_session=os.name != "nt",
    )
    kernel: Any = None
    handle: Any = None
    try:
        # CRITICAL: the helper blocks on stdin before creating its compiler child. Assign the
        # owned job before sending input; closing it must also kill descendants on timeout/OOM.
        if os.name == "nt":
            kernel, handle = _parser_job(process)
        try:
            stdout, stderr = process.communicate(
                json.dumps(request), timeout=PARSER_TIMEOUT_SECONDS
            )
        except subprocess.TimeoutExpired as error:
            raise Refusal("typescript_parser_timeout", 15) from error
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    finally:
        if handle is not None:
            kernel.CloseHandle(handle)
        elif sys.platform != "win32":
            import signal

            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)


def _typescript_graph(
    root: Path, known: set[str], runtime: Path, analysis: dict[str, Any]
) -> tuple[dict[str, dict[str, set[str]]], list[str] | None]:
    paths = sorted(
        name
        for name in known
        if name not in GRAPH_EXCLUSIONS
        and Path(name).suffix in CODE_SUFFIXES
        and (root / name).is_file()
    )
    request = dict(root=str(root), typescriptRoot=str(runtime), paths=paths)
    completed = _parser_run(root, request)
    if completed.returncode:
        if (
            "heap out of memory" in completed.stderr.lower()
            or "out of memory" in completed.stderr.lower()
            or completed.returncode & 0xFFFFFFFF in {0xC0000017, 0xC000009A}
        ):
            raise Refusal("typescript_parser_memory_limit", 16)
        raise Refusal("typescript_import_parse_failed")
    data = json.loads(completed.stdout)
    config_path = root / "frontend/tsconfig.json"
    config = (
        json.loads(config_path.read_text(encoding="utf-8-sig")) if config_path.is_file() else {}
    )
    options = config.get("compilerOptions", {})
    graphs: dict[str, dict[str, set[str]]] = {}
    analysis.update(
        parser=data["parser"],
        limits=parser_limits(),
        external_modules=[],
        excluded_graph_nodes=[
            dict(path=name, reason=reason)
            for name, reason in GRAPH_EXCLUSIONS.items()
            if name in known
        ],
        aliases=data["aliases"],
    )
    for runner in ("vitest", "playwright", "production"):
        graph: dict[str, set[str]] = {}
        aliases = data["aliases"][runner]
        for name, specifiers in data["modules"].items():
            edges: set[str] = set()
            for specifier in specifiers:
                if runner == "production" and specifier in data["externals"]:
                    analysis["external_modules"].append(
                        dict(
                            runner=runner,
                            importer=name,
                            specifier=specifier,
                            rule="declared-external",
                        )
                    )
                    continue
                specifier = specifier.split("?", 1)[0]
                candidates: list[str] = []
                if specifier in aliases:
                    candidates.append(
                        os.path.normpath("frontend/" + aliases[specifier]).replace("\\", "/")
                    )
                elif specifier.startswith("."):
                    candidates.append(
                        os.path.normpath(str(Path(name).parent / specifier)).replace("\\", "/")
                    )
                for pattern, replacements in options.get("paths", {}).items():
                    left, wildcard, right = pattern.partition("*")
                    if (not wildcard and specifier == pattern) or (
                        wildcard and specifier.startswith(left) and specifier.endswith(right)
                    ):
                        middle = specifier[
                            len(left) : len(specifier) - len(right) if right else None
                        ]
                        candidates.extend(
                            os.path.normpath(
                                str(
                                    Path("frontend")
                                    / options.get("baseUrl", ".")
                                    / target.replace("*", middle)
                                )
                            ).replace("\\", "/")
                            for target in replacements
                        )
                for candidate in candidates:
                    path = PurePosixPath(candidate)
                    choices = [candidate]
                    if path.suffix in {".js", ".jsx", ".mjs", ".cjs"}:
                        choices += [
                            str(path.with_suffix(suffix))
                            for suffix in (".ts", ".tsx", ".mts", ".cts")
                        ]
                    elif path.suffix not in CODE_SUFFIXES | {".json", ".css"}:
                        # IMPORTANT: .config and .hc09 are part of the basename, not module
                        # extensions. Treating every dotted name as explicit drops real edges.
                        choices += [
                            candidate + suffix
                            for suffix in (
                                ".ts",
                                ".tsx",
                                ".mts",
                                ".cts",
                                ".js",
                                ".jsx",
                                ".mjs",
                                ".cjs",
                                ".json",
                            )
                        ]
                        choices += [
                            candidate + "/index" + suffix for suffix in (".ts", ".tsx", ".js")
                        ]
                    found = next((choice for choice in choices if choice in known), None)
                    if found:
                        edges.add(found)
                        break
                else:
                    if candidates:
                        raise Refusal(f"local_import_unresolved:{name}:{specifier}")
            graph[name] = edges - {name}
        graphs[runner] = graph
    return graphs, data["playwrightMatches"]


def _test_runner(name: str, matches: list[str] | None) -> str | None:
    if name.startswith("tests/") and Path(name).name.startswith("test_") and name.endswith(".py"):
        return "pytest"
    if name.startswith("frontend/tests/") and re.search(r"\.test\.(?:ts|tsx)$", name):
        return "vitest"
    prefix = "frontend/tests/e2e/"
    if name.startswith(prefix) and name.endswith(".spec.ts"):
        relative = name.removeprefix(prefix)
        if matches is None or any(fnmatchcase(relative, pattern) for pattern in matches):
            return "playwright"
    return None


def _cross_runner_selection(
    graph: dict[str, set[str]], changed: Sequence[str], matches: list[str] | None
) -> list[dict[str, Any]]:
    reverse: dict[str, set[str]] = {}
    for importer, imports in graph.items():
        for dependency in imports:
            reverse.setdefault(dependency, set()).add(importer)
    selected: list[dict[str, Any]] = []
    # CRITICAL: walk resolved import edges in every runner, including re-exports and helpers.
    # Searching only Playwright for a changed e2e helper misses its jsdom Vitest consumers.
    for seed in changed:
        queue = deque([[seed]])
        visited: set[str] = set()
        while queue:
            chain = queue.popleft()
            name = chain[-1]
            if name in visited:
                continue
            visited.add(name)
            runner = _test_runner(name, matches)
            if runner:
                rule = (
                    "changed-test"
                    if name == seed
                    else "python-import"
                    if runner == "pytest"
                    else "typescript-import"
                )
                selected.append(
                    dict(runner=runner, test=name, reasons=[dict(rule=rule, chain=chain)])
                )
            queue.extend([*chain, importer] for importer in sorted(reverse.get(name, set())))
    return selected


def _guard_selection(root: Path, changed: Sequence[str], base: str | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def add(test: str, kind: str, name: str) -> None:
        rows.append(
            dict(runner="pytest", test=test, reasons=[dict(rule="guard:" + kind, chain=[name])])
        )

    for name in changed:
        path = root / name
        raw = path.read_bytes() if path.is_file() else b""
        if not raw and base:
            result = subprocess.run(
                ["git", "show", f"{base}:{name}"], cwd=root, capture_output=True
            )
            raw = result.stdout if result.returncode == 0 else b""
        try:
            raw.decode("utf-8-sig")
            text = b"\x00" not in raw
        except UnicodeError:
            text = False
        # CRITICAL: public text is the audit's input, not its importers. Omitting this rule
        # lets a new journey's private-path example survive every affected module test.
        if text:
            add("tests/test_security_audit.py", "text", name)
        declares_writer = False
        if name.startswith("scripts/") and name.endswith(".py"):
            source = ast.parse(raw or b"", filename=name)
            declares_writer = any(
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_argument"
                and any(
                    isinstance(arg, ast.Constant) and arg.value == "--write" for arg in node.args
                )
                for node in ast.walk(source)
            )
        if name == "scripts/derived_artifacts.py" or declares_writer:
            add("tests/test_m23_48_derived_artifacts.py", "generator-declaration", name)
        bundled = name.startswith("frontend/src/") or name in {
            "frontend/package.json",
            "frontend/pnpm-lock.yaml",
            "frontend/vite.config.ts",
            "frontend/buildProvenance.ts",
            "frontend/buildMetadata.ts",
            "comfyui_h3_context/web/h3-context-sidebar.js",
            "comfyui_h3_context/contracts/build_provenance_v1.json",
            "governance/contracts/supply_chain_v1.json",
            "tests/test_supply_chain_manifest.py",
        }
        if bundled:
            add("tests/test_frontend_build_report.py", "bundle", name)
            add("tests/test_supply_chain_manifest.py", "bundle-pin", name)
        if name.startswith("frontend/src/") or name.startswith(
            "governance/contracts/architecture_"
        ):
            add("tests/test_architecture_fitness.py", "architecture", name)
        if name.startswith(("frontend/src/host/", "frontend/src/lifecycle/")):
            add("tests/test_frontend_module_budget.py", "module-budget", name)
            add("tests/test_hc_09_host_seam_census.py", "host-source", name)
        if name == "requirements/secret-scan-baseline.json":
            add(
                "tests/test_tooling_contract.py::ToolingContractTests::test_secret_baseline_is_valid_and_closed_to_reviewed_public_literals",
                "closed-baseline",
                name,
            )
        if name in {"scripts/repair_prefreeze_check.py", "scripts/repair_import_graph.mjs"}:
            add("tests/test_repair_prefreeze_check.py", "selector-owner", name)
    return rows


def select_tests(
    root: Path,
    changed: Sequence[str],
    *,
    typescript_root: Path | None = None,
    base: str | None = None,
    analysis: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    known = set(git(root, "ls-files", "-z").split("\0")) - {""}
    known.update(changed)
    python_graph = (
        _python_graph(root, known) if any(name.endswith(".py") for name in changed) else {}
    )
    graphs: dict[str, dict[str, set[str]]] = {}
    details = analysis if analysis is not None else {}
    details.update(limits=parser_limits(), external_modules=[], excluded_graph_nodes=[])
    matches = None
    if any(
        Path(name).suffix in CODE_SUFFIXES
        or (
            name.endswith(".json")
            and name.startswith(
                ("frontend/", "comfyui_h3_context/contracts/", "governance/contracts/")
            )
        )
        for name in changed
    ):
        graphs, matches = _typescript_graph(root, known, typescript_root or root, details)
    rows: list[dict[str, Any]] = []
    for runner in RUNNERS:
        graph = python_graph if runner == "pytest" else graphs.get(runner, {})
        rows.extend(
            row
            for row in _cross_runner_selection(graph, changed, matches)
            if row["runner"] == runner
        )
    rows += _guard_selection(root, changed, base)
    merged: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row["test"] in merged:
            merged[row["test"]]["reasons"].extend(
                reason for reason in row["reasons"] if reason not in merged[row["test"]]["reasons"]
            )
        else:
            merged[row["test"]] = row
    # A whole-file reader subsumes its named node; do not execute it twice.
    for test in list(merged):
        filename = test.split("::", 1)[0]
        if filename != test and filename in merged:
            merged[filename]["reasons"].extend(merged.pop(test)["reasons"])
    return [
        dict(id=row["runner"] + ":" + row["test"], **row)
        for row in sorted(merged.values(), key=lambda row: (row["runner"], row["test"]))
    ]


def receipt_location(root: Path, value: Path) -> Path:
    target = value if value.is_absolute() else root / value
    relative = (
        target.absolute().relative_to(root.absolute())
        if target.absolute().is_relative_to(root.absolute())
        else None
    )
    if relative is None or ".." in relative.parts:
        raise Refusal("receipt_outside_workspace")
    for part in [target, *target.parents]:
        if part == root.parent:
            break
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise Refusal("receipt_link_refused")
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", relative.as_posix()],
        cwd=root,
        capture_output=True,
    )
    ignored = subprocess.run(
        ["git", "check-ignore", "--no-index", "--quiet", "--", relative.as_posix()],
        cwd=root,
        capture_output=True,
    )
    if tracked.returncode == 0 or ignored.returncode != 0:
        raise Refusal("receipt_must_be_ignored_and_untracked")
    return target


def validate_receipt(data: Any, head: str, tree: str) -> None:
    def invalid() -> None:
        raise Refusal("receipt_invalid", 13)

    required = {
        "schema",
        "base",
        "head",
        "tree",
        "changed_paths",
        "methods",
        "counts",
        "components",
        "status",
    }
    if not isinstance(data, dict) or not required <= data.keys() or data["schema"] != SCHEMA:
        invalid()
    if data["head"] != head or data["tree"] != tree:
        raise Refusal("receipt_head_mismatch", 12)
    if not isinstance(data["base"], str) or not re.fullmatch(r"[0-9a-f]{40}", data["base"]):
        invalid()
    if not isinstance(data["changed_paths"], list) or any(
        not isinstance(name, str) for name in data["changed_paths"]
    ):
        invalid()
    for name in data["changed_paths"]:
        safe_name(name)
    components = data["components"]
    if not isinstance(components, list) or not components:
        invalid()
    ids: set[str] = set()
    counts = dict.fromkeys(RUNNERS, 0)
    failed = False
    for row in components:
        if (
            not isinstance(row, dict)
            or not {"id", "runner", "test", "reasons", "command", "exit_status", "status"}
            <= row.keys()
        ):
            invalid()
        identity = row["id"]
        if not isinstance(identity, str) or identity in ids:
            invalid()
        ids.add(identity)
        if (
            not isinstance(row["command"], list)
            or not row["command"]
            or any(not isinstance(arg, str) for arg in row["command"])
        ):
            invalid()
        if type(row["exit_status"]) is not int or row["status"] != (
            "PASS" if row["exit_status"] == 0 else "FAIL"
        ):
            invalid()
        if not isinstance(row["reasons"], list) or not row["reasons"]:
            invalid()
        for reason in row["reasons"]:
            if (
                not isinstance(reason, dict)
                or not isinstance(reason.get("rule"), str)
                or not isinstance(reason.get("chain"), list)
            ):
                invalid()
        if not isinstance(row["runner"], str):
            invalid()
        if row["runner"] in counts:
            if not isinstance(row["test"], str) or identity != row["runner"] + ":" + row["test"]:
                invalid()
            counts[row["runner"]] += 1
        else:
            if (
                identity
                not in {"pre_commit", "derived", "checkout", "vitest:runner", "playwright:runner"}
                or row["runner"] != identity
                or row["test"] is not None
            ):
                invalid()
        failed |= row["exit_status"] != 0
    if (
        not {"pre_commit", "derived"} <= ids
        or data["counts"] != counts
        or not isinstance(data["methods"], dict)
        or set(data["methods"]) != set(RUNNERS)
    ):
        invalid()
    if data["status"] != ("FAIL" if failed else "PASS"):
        invalid()
    if "browser_groups" in data:
        groups = data["browser_groups"]
        if not isinstance(groups, list):
            invalid()
        browser = {row["test"]: row for row in components if row["runner"] == "playwright"}
        accounted: set[str] = set()
        for group in groups:
            if (
                not isinstance(group, dict)
                or not {
                    "specs",
                    "environment_names",
                    "command",
                    "log",
                    "exit_status",
                    "status",
                    "cases",
                    "runner_process_exit",
                }
                <= group.keys()
            ):
                invalid()
            specs = group["specs"]
            if (
                not isinstance(specs, list)
                or not specs
                or any(not isinstance(name, str) for name in specs)
            ):
                invalid()
            if (
                len(set(specs)) != len(specs)
                or set(specs) & accounted
                or not set(specs) <= browser.keys()
            ):
                invalid()
            accounted.update(specs)
            preconditions = BROWSER_PRECONDITIONS.get(specs[0], {})
            if any(BROWSER_PRECONDITIONS.get(name, {}) != preconditions for name in specs):
                invalid()
            rows = [browser[name] for name in specs]
            if (
                group["environment_names"] != sorted(preconditions)
                or group["status"]
                != ("FAIL" if any(row["exit_status"] for row in rows) else "PASS")
                or type(group["exit_status"]) is not int
                or (group["exit_status"] == 0) != (group["status"] == "PASS")
                or type(group["cases"]) is not int
                or group["cases"] != sum(row.get("cases", 0) for row in rows)
                or type(group["runner_process_exit"]) is not int
                or any(
                    row["command"] != group["command"]
                    or row.get("log") != group["log"]
                    or row.get("runner_process_exit") != group["runner_process_exit"]
                    for row in rows
                )
            ):
                invalid()
        if accounted != browser.keys():
            invalid()
    if failed:
        raise Refusal("receipt_failed", 11)


def _execute(
    root: Path, command: list[str], log: Path, env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    with log.open("x", encoding="utf-8") as stream:
        stream.write(result.stdout)
        if result.stderr:
            stream.write("\n--- stderr ---\n" + result.stderr)
    return result


def _node_cli(root: Path, package: str, binary: str) -> list[str]:
    package_root = root / "frontend/node_modules" / package
    metadata = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
    entry = metadata["bin"]
    return ["node", str(package_root / (entry[binary] if isinstance(entry, dict) else entry))]


def _reported_path(root: Path, name: str) -> str:
    path = Path(name)
    if path.is_absolute():
        return path.resolve().relative_to(root).as_posix()
    return name if name.startswith("frontend/") else "frontend/" + name


def _browser_preflight(root: Path, env: dict[str, str], logs: Path) -> None:
    import socket

    port = int(env.get("H3_CONTEXT_E2E_PORT", "4431"))
    if port < 1 or port > 65535:
        raise Refusal("browser_port_invalid")
    if os.name == "nt":
        exclusions = _execute(
            root,
            ["netsh", "interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
            logs / "port-exclusions.txt",
            env,
        )
        if exclusions.returncode:
            raise Refusal("browser_exclusions_unavailable")
        for line in exclusions.stdout.splitlines():
            match = re.fullmatch(r"\s*(\d+)\s+(\d+)\s*\*?\s*", line)
            if match and int(match[1]) <= port <= int(match[2]):
                raise Refusal("browser_port_excluded")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", port))


def browser_skip_guards(root: Path, typescript_root: Path) -> dict[str, list[str]]:
    # Inspect every tracked spec; only specs admitted by this runner's exact testMatch can run.
    paths = [
        name
        for name in git(root, "ls-files").splitlines()
        if name.startswith("frontend/tests/e2e/") and name.endswith(".spec.ts")
    ]
    config = "frontend/playwright.config.ts"
    if (root / config).is_file():
        paths.append(config)
    result = _parser_run(
        root, dict(root=str(root), typescriptRoot=str(typescript_root), paths=paths)
    )
    if result.returncode:
        raise Refusal("browser_skip_guard_parse_failed")
    data = json.loads(result.stdout)
    return {
        name: values
        for name, values in data["browserSkipGuards"].items()
        if _test_runner(name, data["playwrightMatches"]) == "playwright"
    }


def _fresh_browser_destination(root: Path, path: Path, kind: str) -> None:
    path.relative_to(root.absolute())
    for parent in (path, *path.parents):
        try:
            reparse = bool(getattr(parent.lstat(), "st_file_attributes", 0) & 0x400)
        except FileNotFoundError:
            reparse = False
        if parent.is_symlink() or reparse:
            raise Refusal("browser_indirect_destination")
        if parent == root.absolute():
            break
    if path.exists():
        raise Refusal("browser_" + kind + "_already_exists")


def _run_browser_groups(
    root: Path, rows: list[dict[str, Any]], logs: Path, env: dict[str, str]
) -> list[dict[str, Any]]:
    partitions: dict[tuple[tuple[str, str], ...], list[dict[str, Any]]] = {}
    for row in rows:
        key = tuple(sorted(BROWSER_PRECONDITIONS.get(row["test"], {}).items()))
        partitions.setdefault(key, []).append(row)
    groups = []
    for index, (preconditions, members) in enumerate(partitions.items()):
        group_env = dict(env)
        # CRITICAL: the loopback flag changes the entire Vite proxy. Never let inherited flags
        # put ordinary mocked journeys against the real fixture, or combine different flag sets.
        for variable in (
            "H3_CONTEXT_E2E_SERVICE_LOOPBACK",
            "H3_CONTEXT_E2E_SERVICE_LOOPBACK_MEDIA",
            "H3_CONTEXT_E2E_OUTPUT_RELAY_DIR",
            "H3_CONTEXT_E2E_PYTHON",
        ):
            group_env.pop(variable, None)
        group_logs = (
            logs if len(partitions) == 1 and not preconditions else logs / f"browser-group-{index}"
        )
        if group_logs != logs:
            group_logs.mkdir()
        # CRITICAL: Playwright clears outputDir at startup. Each partition needs a fresh
        # destination or a later partition deletes earlier failure attachments.
        artifacts = group_logs.absolute() / "artifacts"
        _fresh_browser_destination(root, artifacts, "artifacts")
        group_env["H3_CONTEXT_PLAYWRIGHT_OUTPUT"] = str(artifacts)
        for variable, value in preconditions:
            if value == "target-python":
                value = str(
                    root / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
                )
            elif value == "target-output-relay":
                # CRITICAL: native downloads bypass page.route. Only real-output specs
                # get the Python publisher relay; ordinary specs assert the fallback body.
                namespace = hashlib.sha256(
                    group_logs.relative_to(root).as_posix().encode()
                ).hexdigest()[:24]
                relay = root.absolute() / ".tmp" / ("output-relay-" + namespace)
                _fresh_browser_destination(root, relay, "relay")
                relay.mkdir(parents=True)
                value = str(relay)
            group_env[variable] = value
        try:
            _batch_tests(root, "playwright", members, group_logs, group_env)
        except (OSError, ValueError, KeyError, Refusal) as error:
            for row in members:
                row.update(
                    exit_status=2, status="FAIL", error=type(error).__name__ + ":" + str(error)
                )
        groups.append(
            dict(
                specs=[row["test"] for row in members],
                artifact_directory=artifacts.relative_to(root).as_posix(),
                environment_names=sorted(dict(preconditions)),
                command=members[0].get("command", ["not-run"]),
                log=members[0].get("log", ""),
                runner_process_exit=members[0].get("runner_process_exit", 2),
                cases=sum(row.get("cases", 0) for row in members),
                exit_status=0 if all(row["exit_status"] == 0 for row in members) else 1,
                status="PASS" if all(row["exit_status"] == 0 for row in members) else "FAIL",
            )
        )
    return groups


def _batch_tests(
    root: Path, runner: str, rows: list[dict[str, Any]], logs: Path, env: dict[str, str]
) -> None:
    if not rows:
        return
    selected = [row["test"].removeprefix("frontend/") for row in rows]
    report_file = logs / "vitest-report.json"
    if runner == "vitest":
        # IMPORTANT: Vitest overwrites outputFile; never replace an earlier run's evidence.
        if report_file.exists() or report_file.is_symlink():
            raise Refusal("vitest_report_already_exists")
        command = [
            *_node_cli(root, "vitest", "vitest"),
            "run",
            *selected,
            "--maxWorkers",
            "4",
            "--reporter=json",
            "--outputFile=" + str(report_file.resolve()),
        ]
    else:
        _browser_preflight(root, env, logs)
        command = [
            *_node_cli(root, "@playwright/test", "playwright"),
            "test",
            *selected,
            "--workers",
            "2",
            "--retries",
            "0",
            "--reporter=json",
        ]
    # IMPORTANT: runner arguments are exact escaped paths, not substring filters. A similarly
    # named spec must never silently enter a repair selection (or replace its missing target).
    if runner == "playwright":
        command[command.index("test") + 1 : command.index("--workers")] = [
            "^" + re.escape((root / row["test"]).as_posix()).replace("/", r"[/\\]") + "$"
            for row in rows
        ]
    command = (
        [*command[:2], "--root", str(root / "frontend"), *command[2:]]
        if runner == "vitest"
        else command
    )
    logfile = logs / (runner + ".txt")
    # Playwright resolves its config from cwd; keep all subprocesses inside this checkout.
    cwd = root / "frontend"
    for row in rows:
        row.update(
            command=command, log=logfile.relative_to(root).as_posix(), exit_status=2, status="FAIL"
        )
    result = _execute(cwd, command, logfile, env)
    for row in rows:
        row["runner_process_exit"] = result.returncode
    # CRITICAL: tests may print diagnostic JSON to stdout. Only Vitest's fresh native
    # report is authoritative; decoding all stdout falsely rejects otherwise green runs.
    data = json.loads(
        report_file.read_text(encoding="utf-8") if runner == "vitest" else result.stdout
    )
    if runner == "vitest":
        observed = {_reported_path(root, entry["name"]): entry for entry in data["testResults"]}
        for row in rows:
            entry = observed.get(row["test"])
            if entry is not None:
                cases = entry["assertionResults"]
                ok = (
                    bool(cases)
                    and entry["status"] == "passed"
                    and all(case["status"] == "passed" for case in cases)
                )
                row.update(
                    exit_status=0 if ok else 1, status="PASS" if ok else "FAIL", cases=len(cases)
                )
    else:
        observed_cases: dict[str, list[dict[str, Any]]] = {}

        def walk(suite: dict[str, Any]) -> None:
            for spec in suite.get("specs", []):
                name = spec["file"]
                name = name if Path(name).is_absolute() else "frontend/tests/e2e/" + name
                observed_cases.setdefault(_reported_path(root, name), []).extend(spec["tests"])
            for child in suite.get("suites", []):
                walk(child)

        for suite in data["suites"]:
            walk(suite)
        for row in rows:
            cases = observed_cases.get(row["test"], [])
            ok = (
                bool(cases)
                and not data.get("errors")
                and all(
                    case["expectedStatus"] == "passed"
                    and case["status"] == "expected"
                    and len(case["results"]) == 1
                    and case["results"][0]["status"] == "passed"
                    and case["results"][0]["retry"] == 0
                    for case in cases
                )
            )
            row.update(
                exit_status=0 if ok else 1, status="PASS" if ok else "FAIL", cases=len(cases)
            )
    observed_names = set(observed) if runner == "vitest" else set(observed_cases)
    if observed_names != {row["test"] for row in rows}:
        rows[0].update(exit_status=2, status="FAIL", error="runner_selection_mismatch")
    if result.returncode and all(row["exit_status"] == 0 for row in rows):
        # Keep runner-level errors that have no individual test result visible in the aggregate.
        rows[0].update(exit_status=result.returncode, status="FAIL", runner_error=True)


def _identity_drift_checks(
    root: Path, python: Path, logs: Path, env: dict[str, str]
) -> tuple[bool, list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    # These existing validators have different CLIs; a shared --check rejects valid manifests.
    for script, arguments in (
        ("build_provenance", ["--check"]),
        ("supply_chain_manifest", ["--emit", "validate"]),
    ):
        command = [str(python), "-E", "-s", "-B", f"scripts/{script}.py", *arguments]
        logfile = logs / (script + ".txt")
        result = _execute(root, command, logfile, env)
        checks.append(dict(command=command, exit_status=result.returncode, log=str(logfile)))
    return all(row["exit_status"] == 0 for row in checks), checks


def run_checks(
    root: Path,
    base: str,
    head: str,
    output: Path,
    selected: list[dict[str, Any]],
    analysis: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if git(root, "rev-parse", "HEAD") != head or git(root, "diff", "HEAD", "--name-only"):
        raise Refusal("checkout_must_match_clean_head")
    python = root / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    if not python.is_file() or Path(sys.executable).absolute() != python.absolute():
        raise Refusal("use_target_project_venv")
    if output.exists():
        raise Refusal("receipt_already_exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    logs = output.parent / (output.stem + "-logs")
    logs.mkdir()
    env = dict(os.environ)
    env.update(
        PYTHONUTF8="1",
        PYTHONIOENCODING="utf-8",
        H3_CONTEXT_E2E_PORT=os.environ.get("H3_CONTEXT_E2E_PORT", "4431"),
        PRE_COMMIT_HOME=str(root / ".tmp/pre-commit-home"),
    )
    for name in ("PYTEST_ADDOPTS", "PYTEST_PLUGINS", "PYTHONPATH", "PYTHONHOME"):
        env.pop(name, None)
    components = [
        dict(row, command=["not-run"], exit_status=125, status="FAIL") for row in selected
    ]
    browser_groups = []
    for runner in ("vitest", "pytest", "playwright"):
        rows = [row for row in components if row["runner"] == runner]
        print(f"RUN {runner}: {len(rows)} selected files", flush=True)
        if runner == "playwright":
            browser_groups = _run_browser_groups(root, rows, logs, env)
        elif runner == "vitest":
            try:
                _batch_tests(root, runner, rows, logs, env)
            except (OSError, ValueError, KeyError, Refusal) as error:
                for row in rows:
                    row.update(
                        exit_status=2, status="FAIL", error=type(error).__name__ + ":" + str(error)
                    )
        else:
            for index, row in enumerate(rows):
                # IMPORTANT: equal receipt stems in different evidence directories are
                # distinct runs. Keep freshness refusal, but bind it to the full path.
                namespace = hashlib.sha256(
                    output.relative_to(root).as_posix().encode()
                ).hexdigest()[:24]
                basetemp = f".tmp/pt-rpc-{namespace}-{index}"
                if (root / basetemp).exists() or (root / basetemp).is_symlink():
                    row.update(error="pytest_basetemp_exists")
                    continue
                command = [
                    str(python),
                    "-E",
                    "-s",
                    "-B",
                    "-m",
                    "pytest",
                    row["test"],
                    "-q",
                    "-p",
                    "no:cacheprovider",
                    "--basetemp=" + basetemp,
                ]
                logfile = logs / f"pytest-{index}.txt"
                result = _execute(root, command, logfile, env)
                row.update(
                    command=command,
                    log=logfile.relative_to(root).as_posix(),
                    exit_status=result.returncode,
                    status="PASS" if result.returncode == 0 else "FAIL",
                )
                count = re.search(r"\b(\d+) passed\b", result.stdout)
                row["cases"] = int(count[1]) if count else 0
        for row in rows:
            print(f"{row['status']} {row['test']} exit={row['exit_status']}", flush=True)

    paths = changed_paths(root, base, head)
    for identity, command in (
        (
            "pre_commit",
            [
                str(python),
                "-E",
                "-s",
                "-B",
                "-m",
                "pre_commit",
                "run",
                "--show-diff-on-failure",
                "--files",
                *paths,
            ],
        ),
        (
            "derived",
            [str(python), "-E", "-s", "-B", "scripts/derived_artifacts.py", "dry-run", "--receipt"],
        ),
    ):
        print("RUN " + identity, flush=True)
        logfile = logs / (identity + ".txt")
        result = _execute(root, command, logfile, env)
        row = dict(
            id=identity,
            runner=identity,
            test=None,
            reasons=[
                dict(
                    rule="changed-paths" if identity == "pre_commit" else "derived-dry-run",
                    chain=[],
                )
            ],
            command=command,
            exit_status=result.returncode,
            status="PASS" if result.returncode == 0 else "FAIL",
            log=logfile.relative_to(root).as_posix(),
        )
        if identity == "derived" and result.returncode == 0:
            transaction = json.loads(result.stdout)
            row["pending_outputs"] = [
                entry["path"] for entry in transaction["outputs"] if entry["verdict"] != "unchanged"
            ]
            row["bundle_rebuild_reasons"] = transaction["bundle_rebuild_reasons"]
            # A committed head may advance only provenance and its downstream manifest. Confirm
            # their current checks before treating this as identity-only drift, never rebuild it.
            allowed = {
                "comfyui_h3_context/contracts/build_provenance_v1.json",
                "governance/contracts/supply_chain_v1.json",
            }
            if row["pending_outputs"]:
                identity_only = set(row["pending_outputs"]) <= allowed
                valid, checks = _identity_drift_checks(root, python, logs, env)
                identity_only &= valid
                row["validation_checks"] = checks
                row["identity_only_drift"] = identity_only
                if not identity_only:
                    row.update(exit_status=1, status="FAIL")
        components.append(row)
        print(f"{row['status']} {identity} exit={row['exit_status']}", flush=True)
    checkout = ["git", "diff", "--exit-code", "HEAD", "--"]
    result = _execute(root, checkout, logs / "checkout.txt", env)
    components.append(
        dict(
            id="checkout",
            runner="checkout",
            test=None,
            reasons=[dict(rule="unchanged-head-bytes", chain=[])],
            command=checkout,
            exit_status=result.returncode,
            status="PASS" if result.returncode == 0 else "FAIL",
        )
    )
    receipt = dict(
        analysis=analysis or dict(limits=parser_limits()),
        schema=SCHEMA,
        base=base,
        head=head,
        tree=git(root, "rev-parse", head + "^{tree}"),
        changed_paths=paths,
        methods=dict(
            vitest="typescript-import",
            playwright="typescript-import+configured-testMatch",
            pytest="python-ast+guards",
        ),
        counts={runner: sum(row["runner"] == runner for row in selected) for runner in RUNNERS},
        components=components,
        browser_groups=browser_groups,
        status="FAIL" if any(row["exit_status"] for row in components) else "PASS",
    )
    output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    for mode in ("select", "run", "verify"):
        command = commands.add_parser(mode)
        command.add_argument("--root", type=Path, default=ROOT)
        command.add_argument("--head", required=True)
        if mode != "verify":
            command.add_argument("--base", required=True)
        if mode != "select":
            command.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        root = args.root.resolve()
        head = revision(root, args.head)
        if args.mode == "verify":
            # CRITICAL: freeze verification is read-only. Never launch a runner or repair a
            # stale receipt here; a missing/failed/other-head check must refuse the freeze.
            path = receipt_location(root, args.receipt)
            if not path.is_file():
                raise Refusal("receipt_missing", 10)
            if git(root, "rev-parse", "HEAD") != head:
                raise Refusal("receipt_head_mismatch", 12)
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise Refusal("receipt_invalid", 13) from error
            validate_receipt(data, head, git(root, "rev-parse", head + "^{tree}"))
            print("receipt_verified")
            return 0
        base = revision(root, args.base)
        paths = changed_paths(root, base, head)
        analysis: dict[str, Any] = {}
        selected = select_tests(root, paths, base=base, analysis=analysis)
        print(
            json.dumps(
                dict(
                    analysis=analysis,
                    base=base,
                    head=head,
                    changed_paths=paths,
                    counts={
                        runner: sum(row["runner"] == runner for row in selected)
                        for runner in RUNNERS
                    },
                    selection=selected,
                ),
                indent=2,
            ),
            flush=True,
        )
        if args.mode == "select":
            return 0
        output = receipt_location(root, args.receipt)
        receipt = run_checks(root, base, head, output, selected, analysis)
        print("receipt_" + receipt["status"].lower(), flush=True)
        return 0 if receipt["status"] == "PASS" else 1
    except Refusal as error:
        print(str(error), file=sys.stderr)
        return error.code
    except (OSError, ValueError) as error:
        print("input_unavailable:" + type(error).__name__, file=sys.stderr)
        return 14


if __name__ == "__main__":
    raise SystemExit(main())
