"""Maintainer tool for the native structural admission baselines (T2VA, keyframe, reference).

Reads native source bytes from an explicitly supplied ComfyUI checkout -- a Git revision through
``git show`` or the file on disk -- and never imports, compiles for execution or runs host code.
It imports repository pure code only and prints hashes, closed identifiers and counts, never
native source text. It covers every scope the repository checkout has: an older release line
without the reference scope simply reports and emits fewer tables.

Classify a revision, or the disk file, with the production classifiers of every scope::

    python scripts/native_t2va_structure.py --check --host-root <root> [--revision <rev>]
    python scripts/native_t2va_structure.py --check --scope keyframe --host-root <root>

Derive the manifests of an accepted revision and compare them with the committed lineages. The
shape names the audited rows: ``original`` is the committed first lineage's rows, ``split-latent``
adds ``_av_latent`` before ``_empty_av_latent`` (the helper newer hosts split in two)::

    python scripts/native_t2va_structure.py --host-root <root> --revision <rev> --shape split-latent

Emit a lineage data module, every scope's table of one audited revision::

    python scripts/native_t2va_structure.py --host-root <root> --revision <rev> \\
        --shape split-latent --emit-lineage

Regenerate the first lineage's T2VA baseline module (the committed one is regenerated from this)::

    python scripts/native_t2va_structure.py --host-root <root> --revision b323a345 --emit-python

A disk or Git check is maintainer evidence only. It says nothing about which bytes a running host
loaded; runtime admission comes from the registered-module observer on the actual candidate.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import importlib
import json
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Protocol

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from comfyui_h3_context.core import native_t2va_structure as structure  # noqa: E402

NATIVE_SOURCE = "comfy_extras/nodes_minimax_h3.py"
AUDITED_DEFINITIONS = (
    "align_frame_count",
    "video_latent_t",
    "temporal_shape",
    "_empty_av_latent",
    "EmptyMiniMaxH3LatentAV",
    "MiniMaxH3SigmaShift",
    # Member rows first: a changed member is then named by its own row, not only by its class.
    structure.IMAGE_TO_VIDEO + ".define_schema",
    structure.IMAGE_TO_VIDEO + ".execute",
    structure.IMAGE_TO_VIDEO,
)
SHAPES = ("original", "split-latent")
# The helper newer hosts split in two: its body moves to `_av_latent`, and `_empty_av_latent`
# becomes a wrapper. The helper precedes its only caller, so the audited rows keep that order.
_SPLIT_HELPER = "_av_latent"
_SPLIT_CALLER = "_empty_av_latent"


class _Verdict(Protocol):
    """What the three scopes' verdict types have in common."""

    @property
    def reason(self) -> Enum: ...

    @property
    def admitted(self) -> bool: ...

    @property
    def check(self) -> str: ...

    @property
    def manifest_fingerprint(self) -> str: ...


@dataclass(frozen=True)
class _Scope:
    name: str
    data_name: str
    rows: tuple[str, ...]
    lineages: tuple[structure.NativeT2VABaselineManifest, ...]
    derive: Callable[..., structure.NativeT2VABaselineManifest]
    classify: Callable[[bytes], _Verdict]
    is_production: Callable[[object], bool]


def _names(manifest: structure.NativeT2VABaselineManifest) -> tuple[str, ...]:
    return tuple(name for name, _digest in manifest.definitions)


def _optional_scope(name: str, derive: str) -> _Scope | None:
    """The keyframe or reference scope, or None when this checkout does not have that module.

    CRITICAL: the tool is carried to older release lines that have fewer scopes (the 1.4.5 line has
    no reference scope). A scope is found by import, never named in a static import, so the tool
    runs there unchanged and reports and emits only the scopes the checkout has. Only a missing
    scope module is tolerated: any other import failure is a real fault and must surface.
    """
    path = f"comfyui_h3_context.core.native_{name}_structure"
    try:
        module = importlib.import_module(path)
    except ModuleNotFoundError as error:
        if error.name != path:
            raise
        return None
    return _Scope(
        name,
        f"{name.upper()}_DATA",
        # The audited rows of a scope are the rows of its first production lineage, so the tool
        # keeps no second copy of them.
        _names(module.PRODUCTION_MANIFEST),
        module.PRODUCTION_LINEAGES,
        getattr(module, derive),
        getattr(module, f"classify_native_{name}_source"),
        module.is_production_admission,
    )


# T2VA keeps its named row tuple above because its first baseline module is generated from it.
SCOPES: tuple[_Scope, ...] = (
    _Scope(
        "t2va",
        "T2VA_DATA",
        AUDITED_DEFINITIONS,
        structure.PRODUCTION_LINEAGES,
        structure.derive_manifest,
        structure.classify_native_t2va_source,
        structure.is_production_admission,
    ),
    *(
        scope
        for scope in (
            _optional_scope("keyframe", "derive_keyframe_manifest"),
            _optional_scope("reference", "derive_reference_manifest"),
        )
        if scope is not None
    ),
)


def audited_rows(scope: _Scope, shape: str) -> tuple[str, ...]:
    if shape == "original":
        return scope.rows
    return tuple(
        name
        for row in scope.rows
        for name in ((_SPLIT_HELPER, row) if row == _SPLIT_CALLER else (row,))
    )


def git_blob(content: bytes) -> str:
    header = b"blob " + str(len(content)).encode("ascii") + b"\0"
    return hashlib.sha1(header + content, usedforsecurity=False).hexdigest()


def read_source(host_root: Path, revision: str | None) -> tuple[bytes, str | None]:
    """Return native bytes and the full revision they came from (None for the disk file)."""
    if revision is None:
        content = (host_root / NATIVE_SOURCE).read_bytes()
        return content, None
    full = (
        subprocess.check_output(
            ["git", "-C", str(host_root), "rev-parse", "--verify", revision + "^{commit}"]
        )
        .decode("ascii")
        .strip()
    )
    content = subprocess.check_output(
        ["git", "-C", str(host_root), "show", f"{full}:{NATIVE_SOURCE}"]
    )
    return content, full


def census(content: bytes) -> dict[str, int]:
    tree = ast.parse(content)
    pending: list[tuple[ast.AST, int]] = [(tree, 1)]
    nodes = depth = 0
    while pending:
        node, level = pending.pop()
        nodes += 1
        depth = max(depth, level)
        pending.extend((child, level + 1) for child in ast.iter_child_nodes(node))
    return {"bytes": len(content), "ast_nodes": nodes, "ast_depth": depth}


def _text(value: str) -> str:
    return json.dumps(value)


def _pairs(items: tuple[tuple[str, str], ...]) -> str:
    return "".join(
        f"    (\n        {_text(name)},\n        {_text(value)},\n    ),\n" for name, value in items
    )


def _singles(items: tuple[str, ...]) -> str:
    return "".join(f"    {_text(name)},\n" for name in items)


def render_python(manifest: structure.NativeT2VABaselineManifest) -> str:
    """Emit the baseline module exactly as `ruff format` leaves it, so regeneration is stable."""
    return (
        '"""Accepted native T2VA structural baseline: per-definition digests, never source text.\n'
        "\n"
        "Generated by ``scripts/native_t2va_structure.py --host-root <root>\n"
        f"--revision {manifest.source_revision[:8]} --emit-python``. Regenerate only for a newly\n"
        "audited baseline; the classifier schema and this table are versioned together and both\n"
        "are part of managed qualification compiler identity.\n"
        '"""\n'
        "\n"
        f"SOURCE_REVISION = {_text(manifest.source_revision)}  # pragma: allowlist secret\n"
        f"SOURCE_BLOB = {_text(manifest.source_blob)}  # pragma: allowlist secret\n"
        f"DEFINITIONS: tuple[tuple[str, str], ...] = (\n{_pairs(manifest.definitions)})\n"
        f"CONSTANTS: tuple[tuple[str, str], ...] = (\n{_pairs(manifest.constants)})\n"
        f"PACKAGE_ROOTS: tuple[str, ...] = (\n{_singles(manifest.package_roots)})\n"
        f"REQUIRED_IMPORTS: tuple[str, ...] = (\n{_singles(manifest.required_imports)})\n"
        f"FROM_BINDINGS: tuple[tuple[str, str], ...] = (\n{_pairs(manifest.from_bindings)})\n"
        "ENVELOPE_BINDINGS: tuple[tuple[str, str], ...] = (\n"
        f"{_pairs(manifest.envelope_bindings)})\n"
        f"PROTECTED_BUILTINS: tuple[str, ...] = (\n{_singles(manifest.protected_builtins)})\n"
        f"EXTERNAL_PATHS: tuple[str, ...] = (\n{_singles(manifest.external_paths)})\n"
    )


def _field(key: str, rendered: str) -> str:
    return f'    "{key}": (\n{rendered}    ),\n' if rendered else f'    "{key}": (),\n'


def _indented(rendered: str) -> str:
    return "".join(f"    {line}\n" for line in rendered.splitlines())


def _data_block(name: str, manifest: structure.NativeT2VABaselineManifest) -> str:
    return (
        f"{name}: _ManifestData = {{\n"
        f'    "source_revision": {_text(manifest.source_revision)},  # pragma: allowlist secret\n'
        f'    "source_blob": {_text(manifest.source_blob)},  # pragma: allowlist secret\n'
        + _field("definitions", _indented(_pairs(manifest.definitions)))
        + _field("constants", _indented(_pairs(manifest.constants)))
        + _field("package_roots", _indented(_singles(manifest.package_roots)))
        + _field("required_imports", _indented(_singles(manifest.required_imports)))
        + _field("from_bindings", _indented(_pairs(manifest.from_bindings)))
        + _field("envelope_bindings", _indented(_pairs(manifest.envelope_bindings)))
        + _field("protected_builtins", _indented(_singles(manifest.protected_builtins)))
        + _field("external_paths", _indented(_singles(manifest.external_paths)))
        + "}\n"
    )


def render_lineage(manifests: dict[str, structure.NativeT2VABaselineManifest], shape: str) -> str:
    """Emit one lineage data module: every scope's table of one audited revision."""
    anchor = manifests["t2va"]
    return (
        '"""Audited native structural baselines of one source shape: digests, never source text.\n'
        "\n"
        f"Shape ``{shape}``: the audited rows of the committed first lineage, with the "
        "empty-latent\n"
        "helper split into ``_av_latent`` plus its wrapper. Each table is derived from the native\n"
        "source at the revision it names; provenance identifies that audited input and is never\n"
        "compared with a loaded source. Generated by ``scripts/native_t2va_structure.py\n"
        f"--host-root <root> --revision {anchor.source_revision[:8]} --shape {shape} "
        "--emit-lineage``.\n"
        "Regenerate only for a newly audited shape; these tables are part of managed "
        "qualification\n"
        "compiler identity.\n"
        '"""\n'
        "\n"
        "from typing import TypedDict\n"
        "\n"
        "\n"
        "class _ManifestData(TypedDict):\n"
        "    source_revision: str\n"
        "    source_blob: str\n"
        "    definitions: tuple[tuple[str, str], ...]\n"
        "    constants: tuple[tuple[str, str], ...]\n"
        "    package_roots: tuple[str, ...]\n"
        "    required_imports: tuple[str, ...]\n"
        "    from_bindings: tuple[tuple[str, str], ...]\n"
        "    envelope_bindings: tuple[tuple[str, str], ...]\n"
        "    protected_builtins: tuple[str, ...]\n"
        "    external_paths: tuple[str, ...]\n"
        "\n"
        "\n" + "\n\n".join(_data_block(scope.data_name, manifests[scope.name]) for scope in SCOPES)
    )


def _scope_results(content: bytes, selected: tuple[_Scope, ...]) -> dict[str, dict[str, object]]:
    results: dict[str, dict[str, object]] = {}
    for scope in selected:
        verdict = scope.classify(content)
        results[scope.name] = {
            "reason": str(verdict.reason.value),
            "check": verdict.check,
            "manifest_fingerprint": verdict.manifest_fingerprint,
            "production_admission": scope.is_production(verdict),
            "admitted": verdict.admitted,
        }
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--host-root", required=True, type=Path)
    parser.add_argument("--revision", help="Git revision; omit with --check for the disk file")
    parser.add_argument("--check", action="store_true", help="classify with the production table")
    parser.add_argument(
        "--scope",
        choices=("all", *(scope.name for scope in SCOPES)),
        default="all",
        help="with --check: the scopes to classify (default every scope this checkout has)",
    )
    parser.add_argument("--shape", choices=SHAPES, default="original", help="audited rows")
    parser.add_argument("--emit-python", action="store_true", help="print the T2VA baseline module")
    parser.add_argument("--emit-lineage", action="store_true", help="print a lineage data module")
    args = parser.parse_args(argv)
    content, full = read_source(args.host_root, args.revision)
    blob = git_blob(content)
    facts: dict[str, object] = {
        "python": sys.version.split()[0],
        "subject": full or "disk",
        "source_blob": blob,
        **census(content),
    }
    if args.check:
        selected = tuple(item for item in SCOPES if args.scope in ("all", item.name))
        results = _scope_results(content, selected)
        facts.update(
            {
                "mode": "check",
                "scopes": results,
                "scope": "maintainer disk/Git classification; not loaded-runtime evidence",
            }
        )
        print(json.dumps(facts, indent=2))
        return 0 if all(item["admitted"] for item in results.values()) else 1
    if full is None:
        parser.error("deriving a baseline requires --revision")
    if args.emit_python:
        manifest = structure.derive_manifest(
            content, source_revision=full, source_blob=blob, definitions=AUDITED_DEFINITIONS
        )
        # LF bytes: Windows text-mode stdout would emit CRLF and break the ruff-stable table.
        sys.stdout.buffer.write(render_python(manifest).encode("utf-8"))
        return 0
    manifests = {
        scope.name: scope.derive(
            content,
            source_revision=full,
            source_blob=blob,
            definitions=audited_rows(scope, args.shape),
        )
        for scope in SCOPES
    }
    if args.emit_lineage:
        sys.stdout.buffer.write(render_lineage(manifests, args.shape).encode("utf-8"))
        return 0
    facts.update(
        {
            "mode": "derive",
            "shape": args.shape,
            "scopes": {
                scope.name: {
                    "rows": len(audited_rows(scope, args.shape)),
                    "manifest_fingerprint": manifests[scope.name].fingerprint,
                    "matches_committed_lineage": [
                        index
                        for index, committed in enumerate(scope.lineages)
                        if committed == manifests[scope.name]
                    ],
                }
                for scope in SCOPES
            },
        }
    )
    print(json.dumps(facts, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
