"""Shared, content-free capability fact for native image guides."""

from __future__ import annotations

import ast
from dataclasses import dataclass

from .canonical import canonical_fingerprint
from .native_t2va_structure import _parse, _Refusal

GUIDE_NODE_ID = "MiniMaxH3AddGuide"
GUIDE_REQUIRED_INPUTS = frozenset({"positive", "vae", "latent", "image", "frame_idx"})


@dataclass(frozen=True, slots=True)
class NativeGuideCapability:
    registered: bool
    input_names: frozenset[str]

    def __post_init__(self) -> None:
        if (
            type(self.registered) is not bool
            or type(self.input_names) is not frozenset
            or len(self.input_names) > 64
            or any(type(name) is not str or not 1 <= len(name) <= 128 for name in self.input_names)
        ):
            raise ValueError("invalid_native_guide_capability")

    @property
    def admitted(self) -> bool:
        return self.registered and GUIDE_REQUIRED_INPUTS <= self.input_names

    @property
    def fingerprint(self) -> str:
        return canonical_fingerprint(
            {
                "schema": "h3.native_image_guide_capability.v1",
                "registered": self.registered,
                "inputs": sorted(self.input_names),
            }
        )


def observe_guide_capability(content: bytes, *, registered: bool) -> NativeGuideCapability:
    """Read literal schema names from the same bounded buffer, without invoking host code.

    This fact is necessary but insufficient: a keyframe structural verdict separately proves
    the entire schema/index/conditioning definition. An input-name match grants no execution.
    """
    try:
        tree = _parse(content)
    except (_Refusal, RecursionError):
        return NativeGuideCapability(False, frozenset())
    owners = [
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == GUIDE_NODE_ID
    ]
    if len(owners) != 1:
        return NativeGuideCapability(False, frozenset())
    methods = [
        node
        for node in owners[0].body
        if isinstance(node, ast.FunctionDef) and node.name == "define_schema"
    ]
    if len(methods) != 1:
        return NativeGuideCapability(False, frozenset())
    schemas = [
        node
        for node in ast.walk(methods[0])
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "Schema"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "io"
    ]
    if len(schemas) != 1:
        return NativeGuideCapability(False, frozenset())
    inputs = [kw.value for kw in schemas[0].keywords if kw.arg == "inputs"]
    if len(inputs) != 1 or not isinstance(inputs[0], ast.List) or len(inputs[0].elts) > 64:
        return NativeGuideCapability(False, frozenset())
    names = []
    for item in inputs[0].elts:
        if (
            not isinstance(item, ast.Call)
            or not isinstance(item.func, ast.Attribute)
            or item.func.attr != "Input"
            or not item.args
            or not isinstance(item.args[0], ast.Constant)
            or type(item.args[0].value) is not str
            or not 1 <= len(item.args[0].value) <= 128
        ):
            return NativeGuideCapability(False, frozenset())
        names.append(item.args[0].value)
    if len(names) != len(set(names)):
        return NativeGuideCapability(False, frozenset())
    return NativeGuideCapability(registered, frozenset(names))
