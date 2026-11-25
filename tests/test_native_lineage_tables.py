"""The committed production lineages of the two native structure scopes, as data.

These rows need no upstream source: they pin the second lineage's fingerprints and state how each
scope's second table differs from its first. Admission of real upstream sources is maintainer
evidence (``scripts/native_t2va_structure.py --check``), not a unit test.
"""

from __future__ import annotations

import importlib
import re
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from comfyui_h3_context.core import native_baseline_v0_44 as lineage_module

_STRUCTURE = "comfyui_h3_context.core.native_{}_structure"
_HEX_40 = re.compile(r"[0-9a-f]{40}")
_SPLIT_HELPER = "_av_latent"
_SPLIT_CALLER = "_empty_av_latent"


@dataclass(frozen=True)
class _Scope:
    name: str
    verdict_type: str
    reason_type: str
    first: str
    second: str
    # Literal constants the second source carries that the first one did not, pinned like every
    # other module-level literal.
    added_constants: frozenset[str]


SCOPES = (
    _Scope(
        "t2va",
        "NativeT2VAStructureVerdict",
        "StructureReason",
        "sha256:9f37572101bc6cfd3acf41236e65d915d09ff3ce1641fbc4dd37a369e31b88c9",
        "sha256:3c262899632b69e93296f240aacd9936aeaba3afa2aa33440457ecbb6c417839",
        frozenset({"PH3_IMAGE_EDIT", "PH3_IMAGE_SIZE", "PH3_IMAGE_VISION_PIXELS"}),
    ),
    _Scope(
        "keyframe",
        "NativeKeyframeStructureVerdict",
        "KeyframeStructureReason",
        "sha256:61c1ff85ea8d0f4de3d046b387770bb738705cf4e0d33cc0e4f1d290524690bf",
        "sha256:baa041e6b6809b072190e953f4a5f6eb251e2d0de298ed1f1681dd53dfbb4006",
        frozenset({"PH3_IMAGE_EDIT", "PH3_IMAGE_SIZE", "PH3_IMAGE_VISION_PIXELS"}),
    ),
)
IDS = [scope.name for scope in SCOPES]


def _module(scope: _Scope) -> ModuleType:
    return importlib.import_module(_STRUCTURE.format(scope.name))


@pytest.mark.parametrize("scope", SCOPES, ids=IDS)
def test_each_scope_holds_the_two_audited_lineages_oldest_first(scope: _Scope) -> None:
    module = _module(scope)
    lineages = module.PRODUCTION_LINEAGES
    assert type(lineages) is tuple and len(lineages) == 2
    assert lineages[0] is module.PRODUCTION_MANIFEST
    assert [item.fingerprint for item in lineages] == [scope.first, scope.second]
    assert module.PRODUCTION_FINGERPRINTS == {scope.first, scope.second}
    assert all(_HEX_40.fullmatch(item.source_revision) for item in lineages)
    assert all(_HEX_40.fullmatch(item.source_blob) for item in lineages)
    assert lineages[0].source_blob != lineages[1].source_blob


@pytest.mark.parametrize("scope", SCOPES, ids=IDS)
def test_the_second_lineage_differs_from_the_first_only_where_the_helper_split(
    scope: _Scope,
) -> None:
    first, second = _module(scope).PRODUCTION_LINEAGES
    first_rows = dict(first.definitions)
    second_rows = dict(second.definitions)
    expected_order = [
        name
        for row in first_rows
        for name in ((_SPLIT_HELPER, row) if row == _SPLIT_CALLER else (row,))
    ]
    assert list(second_rows) == expected_order
    changed = {name for name in first_rows if first_rows[name] != second_rows[name]}
    assert changed == {_SPLIT_CALLER}
    # Everything the closure is built from is the same table; only the pinned literals may grow.
    for field in (
        "package_roots",
        "required_imports",
        "from_bindings",
        "envelope_bindings",
        "protected_builtins",
        "external_paths",
    ):
        assert getattr(second, field) == getattr(first, field), field
    first_constants, second_constants = dict(first.constants), dict(second.constants)
    assert set(second_constants) - set(first_constants) == scope.added_constants
    assert set(first_constants) <= set(second_constants)
    assert all(second_constants[name] == digest for name, digest in first_constants.items())


def test_each_generated_module_is_what_the_renderer_makes_from_its_manifests() -> None:
    # A generated baseline module is never edited by hand: the maintainer tool's renderer must
    # reproduce the committed bytes from the committed manifests, so a hand edit (or a table
    # that drifted from its manifest) fails here without any upstream source.
    from comfyui_h3_context.core import native_t2va_baseline
    from comfyui_h3_context.core import native_t2va_structure as structure
    from scripts import native_t2va_structure as tool

    assert [scope.name for scope in tool.SCOPES] == ["t2va", "keyframe"]
    second = {scope.name: scope.lineages[1] for scope in tool.SCOPES}
    committed = Path(str(lineage_module.__file__)).read_bytes()
    assert tool.render_lineage(second, "split-latent").encode("utf-8") == committed
    first_t2va = Path(str(native_t2va_baseline.__file__)).read_bytes()
    assert tool.render_python(structure.PRODUCTION_MANIFEST).encode("utf-8") == first_t2va


def test_the_tool_skips_a_scope_the_checkout_lacks_and_surfaces_any_other_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A release line that lacks a scope has its module simply absent, and the tool reports fewer
    # scopes. A different import failure inside an existing module is a real fault.
    from scripts import native_t2va_structure as tool

    assert tool._optional_scope("no_such_scope", "derive_no_such_manifest") is None

    def broken(path: str) -> ModuleType:
        raise ModuleNotFoundError("a dependency is gone", name="not_the_scope_module")

    monkeypatch.setattr(importlib, "import_module", broken)
    with pytest.raises(ModuleNotFoundError, match="dependency"):
        tool._optional_scope("keyframe", "derive_keyframe_manifest")


def test_the_lineage_module_holds_exactly_the_two_scope_tables() -> None:
    names = {name for name in vars(lineage_module) if name.endswith("_DATA")}
    assert names == {"T2VA_DATA", "KEYFRAME_DATA"}
    keys = {tuple(sorted(getattr(lineage_module, name))) for name in names}
    assert len(keys) == 1


@pytest.mark.parametrize("scope", SCOPES, ids=IDS)
def test_a_verdict_against_each_production_lineage_is_a_production_admission(
    scope: _Scope,
) -> None:
    module = _module(scope)
    verdict_type: Any = getattr(module, scope.verdict_type)
    reason: Any = getattr(module, scope.reason_type)
    for fingerprint in (scope.first, scope.second):
        assert module.is_production_admission(
            verdict_type(reason.ADMITTED, "admitted", fingerprint)
        )
        assert not module.is_production_admission(
            verdict_type(reason.CHANGED, "definition:FPS", fingerprint)
        )
    # A fingerprint that is not a production lineage's never is, whatever the verdict says.
    other = "sha256:" + "0" * 64
    assert not module.is_production_admission(verdict_type(reason.ADMITTED, "admitted", other))
