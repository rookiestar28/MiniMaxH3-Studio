"""Synthetic lineage-B shaped native source and the closed regex-form tables, authored for tests.

Nothing here is ComfyUI source text. ``LINEAGE_B_SOURCE`` is the synthetic T2VA module of
``native_t2va_fixtures`` reshaped the way a newer host reshapes its module: a module-level compiled
regular expression and the latent helper split in two (``_av_latent`` plus the empty-latent
wrapper). The tables name each refusal after the guard of the closed assignment form that makes it.

This module has no pytest dependency, like ``native_t2va_fixtures``.
"""

from __future__ import annotations

from native_t2va_fixtures import SYNTHETIC_DEFINITIONS, SYNTHETIC_SOURCE, mutate

from comfyui_h3_context.core import native_t2va_structure as structure

#: The one module-level regular expression a lineage-B shaped source carries. Doubled backslashes
#: keep the generated source text a raw string literal.
PATTERN_NAME = "SYNTHETIC_MARKER"
PATTERN_LINE = PATTERN_NAME + ' = re.compile(r"\\s*(Synthetic <Item \\d+>|marker:)")\n'

_ORIGINAL_EMPTY_LATENT = (
    "def _empty_av_latent(width, height, frames):\n"
    "    video, audio = temporal_shape(frames)\n"
    "    device = comfy.model_management.intermediate_device()\n"
    "    return torch.zeros([1, 16, video, height // 8, width // 8], device=device), audio\n"
)
_SPLIT_EMPTY_LATENT = (
    "def _av_latent(width, height, video, audio):\n"
    "    device = comfy.model_management.intermediate_device()\n"
    "    return torch.zeros([1, 16, video, height // 8, width // 8], device=device), audio\n"
    "\n"
    "\n"
    "def _empty_av_latent(width, height, frames):\n"
    "    video, audio = temporal_shape(frames)\n"
    "    return _av_latent(width, height, video, audio)\n"
)


def variant(source: str, *pairs: tuple[str, str]) -> str:
    """Apply replacements in order; each must match exactly once in the text it is applied to."""
    for old, new in pairs:
        source = mutate(source, old, new)
    return source


#: The three edits that reshape a lineage-A shaped synthetic source into its lineage-B shape. They
#: apply to the T2VA fixture and, unchanged, to the keyframe test source built on it.
LINEAGE_B_EDITS: tuple[tuple[str, str], ...] = (
    ("import torch\n", "import re\nimport torch\n"),
    ("AUDIO_LATENT_FPS = 25\n", "AUDIO_LATENT_FPS = 25\n" + PATTERN_LINE),
    (_ORIGINAL_EMPTY_LATENT, _SPLIT_EMPTY_LATENT),
)


def to_lineage_b(source: str) -> str:
    return variant(source, *LINEAGE_B_EDITS)


def lineage_b_definitions(definitions: tuple[str, ...]) -> tuple[str, ...]:
    """The audited rows of a lineage-B manifest: the lineage-A rows plus the split helper, which
    precedes its only caller."""
    return tuple(
        name
        for item in definitions
        for name in (("_av_latent", item) if item == "_empty_av_latent" else (item,))
    )


LINEAGE_B_SOURCE = to_lineage_b(SYNTHETIC_SOURCE)
LINEAGE_B_DEFINITIONS = lineage_b_definitions(SYNTHETIC_DEFINITIONS)

#: A lineage-B shaped source whose audited ``video_latent_t`` reads the regular expression, so the
#: statement is part of the audited surface and a manifest must pin it.
PATTERN_READ_SOURCE = variant(
    LINEAGE_B_SOURCE,
    (
        "    return (align_frame_count(frames) - 1) // 4 + 1\n",
        "    return (align_frame_count(frames) - 1) // 4 + 1 + len("
        + PATTERN_NAME
        + ".pattern) * 0\n",
    ),
)


def lineage_a_manifest() -> structure.NativeT2VABaselineManifest:
    return structure.derive_manifest(
        SYNTHETIC_SOURCE.encode("utf-8"),
        source_revision="synthetic-a",
        source_blob="0" * 40,
        definitions=SYNTHETIC_DEFINITIONS,
    )


def lineage_b_manifest(
    source: str = LINEAGE_B_SOURCE,
) -> structure.NativeT2VABaselineManifest:
    return structure.derive_manifest(
        source.encode("utf-8"),
        source_revision="synthetic-b",
        source_blob="2" * 40,
        definitions=LINEAGE_B_DEFINITIONS,
    )


def with_pattern(line: str) -> str:
    """The lineage-B shaped source with its one regular-expression statement replaced."""
    return mutate(LINEAGE_B_SOURCE, PATTERN_LINE, line)


#: id -> statement text that replaces the pattern line. Each must stay admitted by lineage B.
REGEX_FORMS_ADMITTED: dict[str, str] = {
    "pattern_only": PATTERN_LINE,
    "int_flags": PATTERN_NAME + ' = re.compile("x", 2)\n',
    "named_flag": PATTERN_NAME + ' = re.compile("x", re.IGNORECASE)\n',
    "short_flag": PATTERN_NAME + ' = re.compile("x", re.I)\n',
    "joined_flags": PATTERN_NAME + ' = re.compile("x", re.I | re.MULTILINE | re.S)\n',
    "two_statements": PATTERN_LINE + "SYNTHETIC_OTHER = " + 're.compile("y")\n',
    "adjacent_literals": PATTERN_NAME + ' = re.compile("a" "b")\n',
}

#: id -> (replacement pairs applied to the lineage-B source, expected closed refusal identifier).
#: Each row names the guard of the closed form that refuses it; the mutation receipt removes that
#: guard and the row must then fail.
REGEX_FORMS_REFUSED: dict[str, tuple[tuple[tuple[str, str], ...], str]] = {
    # The callee: only ``re.compile`` on the plain-imported ``re``.
    "call_is_not_a_regex": (((PATTERN_LINE, PATTERN_NAME + " = len([1])\n"),), "envelope_assign"),
    "call_on_another_root": (
        ((PATTERN_LINE, PATTERN_NAME + " = torch.zeros(1)\n"),),
        "envelope_assign",
    ),
    "another_re_function": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.escape("x")\n'),),
        "envelope_assign",
    ),
    "method_on_the_compiled_value": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x").match\n'),),
        "envelope_assign",
    ),
    # The receiver of the callee must be the bound module's own name, not a longer expression that
    # merely ends in `.compile`.
    "call_on_an_attribute_receiver": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.re.compile("x")\n'),),
        "envelope_assign",
    ),
    "call_on_a_call_receiver": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("y").compile("x")\n'),),
        "envelope_assign",
    ),
    "call_nested_in_a_container": (
        ((PATTERN_LINE, PATTERN_NAME + ' = (re.compile("x"),)\n'),),
        "envelope_assign",
    ),
    "call_inside_an_operation": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x") | 1\n'),),
        "envelope_assign",
    ),
    "from_import_of_compile": (
        (
            ("import re\n", "from re import compile\n"),
            (PATTERN_LINE, PATTERN_NAME + ' = compile("x")\n'),
        ),
        "envelope_assign",
    ),
    # The binding of ``re``: a plain ``import re`` that nothing rebinds.
    "re_is_never_imported": ((("import re\n", ""),), "envelope_assign"),
    "re_is_imported_after_the_statement": (
        (("import re\n", ""), (PATTERN_LINE, PATTERN_LINE + "import re\n")),
        "envelope_assign",
    ),
    "re_import_is_aliased": (
        (("import re\n", "import re as r\n"),),
        "envelope_assign",
    ),
    "aliased_import_and_method": (
        (
            ("import re\n", "import re as r\n"),
            (PATTERN_LINE, PATTERN_NAME + ' = r.compile("x")\n'),
        ),
        "envelope_assign",
    ),
    "re_import_is_dotted": ((("import re\n", "import re.sub\n"),), "envelope_assign"),
    "re_is_rebound_after": (((PATTERN_LINE, PATTERN_LINE + "re = 3\n"),), "envelope_duplicate"),
    "re_is_rebound_before": ((("import re\n", "re = 3\nimport re\n"),), "envelope_duplicate"),
    "re_is_defined_as_a_function": (
        ((PATTERN_LINE, PATTERN_LINE + "\n\ndef re(value):\n    return value\n\n"),),
        "envelope_duplicate",
    ),
    "re_is_bound_by_a_from_import": (
        ((PATTERN_LINE, PATTERN_LINE + "from json import re\n"),),
        "envelope_duplicate",
    ),
    # The arguments: one pattern literal and at most one flags value, positional only.
    "no_argument": (((PATTERN_LINE, PATTERN_NAME + " = re.compile()\n"),), "envelope_assign"),
    "extra_argument": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", 0, 1)\n'),),
        "envelope_assign",
    ),
    "keyword_flags": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", flags=re.I)\n'),),
        "envelope_assign",
    ),
    "starred_argument": (
        ((PATTERN_LINE, PATTERN_NAME + " = re.compile(*FPS)\n"),),
        "envelope_assign",
    ),
    # The pattern: a plain string literal only.
    "pattern_is_a_name": (
        ((PATTERN_LINE, PATTERN_NAME + " = re.compile(FPS)\n"),),
        "envelope_assign",
    ),
    "pattern_is_a_call": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile(len("x"))\n'),),
        "envelope_assign",
    ),
    "pattern_is_bytes": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile(b"x")\n'),),
        "envelope_assign",
    ),
    "pattern_is_an_fstring": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile(f"{FPS}")\n'),),
        "envelope_assign",
    ),
    "pattern_is_concatenated": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("a" + "b")\n'),),
        "envelope_assign",
    ),
    # The flags: an int literal or uppercase ``re`` attributes joined with ``|``.
    "flags_is_a_name": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", FPS)\n'),),
        "envelope_assign",
    ),
    "flags_attribute_is_lowercase": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", re.i)\n'),),
        "envelope_assign",
    ),
    "flags_are_added": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", re.I + re.M)\n'),),
        "envelope_assign",
    ),
    "flags_is_a_bool": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", True)\n'),),
        "envelope_assign",
    ),
    "flags_is_a_float": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", 1.5)\n'),),
        "envelope_assign",
    ),
    "flags_is_negative": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", -1)\n'),),
        "envelope_assign",
    ),
    "flags_attribute_is_nested": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", re.RegexFlag.IGNORECASE)\n'),),
        "envelope_assign",
    ),
    "flags_attribute_is_on_another_root": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", torch.I)\n'),),
        "envelope_assign",
    ),
    "flags_is_a_call": (
        ((PATTERN_LINE, PATTERN_NAME + ' = re.compile("x", re.I.__or__(re.M))\n'),),
        "envelope_assign",
    ),
    # The target: one plain name that is neither protected nor already bound.
    "target_is_a_tuple": (
        ((PATTERN_LINE, 'SYNTHETIC_A, SYNTHETIC_B = re.compile("x"), re.compile("y")\n'),),
        "envelope_assign",
    ),
    "target_is_chained": (
        ((PATTERN_LINE, 'SYNTHETIC_A = SYNTHETIC_B = re.compile("x")\n'),),
        "envelope_assign",
    ),
    "target_is_a_defined_name": (
        ((PATTERN_LINE, PATTERN_LINE + 'align_frame_count = re.compile("x")\n'),),
        "binding:align_frame_count",
    ),
    "target_is_a_builtin": (
        ((PATTERN_LINE, PATTERN_LINE + 'round = re.compile("x")\n'),),
        "binding:round",
    ),
    "target_is_a_package_root": (
        ((PATTERN_LINE, PATTERN_LINE + 'torch = re.compile("x")\n'),),
        "binding:torch",
    ),
    "target_is_a_pinned_constant": (
        (("FPS = 24\n", 'FPS = re.compile("x")\n'),),
        "constant:FPS",
    ),
    "target_is_a_dunder": (
        ((PATTERN_LINE, PATTERN_LINE + '__all__ = re.compile("x")\n'),),
        "envelope_dunder",
    ),
    "target_is_bound_twice": (
        ((PATTERN_LINE, PATTERN_LINE + PATTERN_LINE),),
        "envelope_duplicate",
    ),
    # Where: module level only. Class bodies and defaults keep refusing every call.
    "class_body_statement": (
        (
            (
                "class SyntheticExtension(ComfyExtension):\n",
                'class SyntheticExtension(ComfyExtension):\n    registered = re.compile("x")\n',
            ),
        ),
        "envelope_class",
    ),
    "function_default": (
        (
            (
                "    async def get_node_list(self):",
                '    async def get_node_list(self, hook=re.compile("x")):',
            ),
        ),
        "envelope_function",
    ),
}
