"""Parse-only admission of unmasked native keyframes and explicit image guides.

The manifest proves the selected definitions and their definition-time dependency closure.
It does not compare a loaded source's version, revision or blob. Imported libraries and runtime
monkeypatches are outside this static proof; registered objects remain receipt currentness facts.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum

from . import native_t2va_structure as structure
from .native_keyframe_baseline import MANIFEST_DATA

NATIVE_KEYFRAME_CLASSIFIER_SCHEMA = "h3.native_keyframe_structure.v1"
NATIVE_KEYFRAME_MANIFEST_SCHEMA = "h3.native_keyframe_baseline_manifest.v1"


class KeyframeStructureReason(str, Enum):
    ADMITTED = "native_keyframe_structure_admitted"
    CHANGED = "native_keyframe_structure_changed"
    UNPARSABLE = "native_keyframe_structure_unparsable"


@dataclass(frozen=True, slots=True)
class NativeKeyframeBaselineManifest(structure.NativeT2VABaselineManifest):
    def to_wire(self) -> dict[str, object]:
        # Explicit base call also works with slots dataclasses on supported Python versions.
        wire = structure.NativeT2VABaselineManifest.to_wire(self)
        return {
            **wire,
            "schema": NATIVE_KEYFRAME_MANIFEST_SCHEMA,
            "classifier_schema": NATIVE_KEYFRAME_CLASSIFIER_SCHEMA,
        }


PRODUCTION_MANIFEST = NativeKeyframeBaselineManifest(**MANIFEST_DATA)


@dataclass(frozen=True, slots=True)
class NativeKeyframeStructureVerdict:
    reason: KeyframeStructureReason
    check: str
    manifest_fingerprint: str
    classifier_schema: str = NATIVE_KEYFRAME_CLASSIFIER_SCHEMA

    @property
    def admitted(self) -> bool:
        return self.reason is KeyframeStructureReason.ADMITTED


def _classify(
    content: bytes, manifest: NativeKeyframeBaselineManifest
) -> NativeKeyframeStructureVerdict:
    try:
        envelope = structure._check_envelope(structure._parse(content), manifest)
        expected = dict(manifest.definitions) | dict(manifest.constants)
        # CRITICAL: frame callers execute the bodies masked by binding-free T2VA admission.
        # Never reuse its masked surface: that would admit changed frame indices/conditioning.
        for name, node in structure._surface_nodes(
            envelope.definitions, (name for name, _ in manifest.definitions), mask_keyframes=False
        ):
            if structure.definition_digest(node) != expected[name]:
                raise structure._changed("definition:" + name)
        for name, _ in manifest.constants:
            constant_node = envelope.constants.get(name)
            if (
                constant_node is None
                or structure.definition_digest(constant_node) != expected[name]
            ):
                raise structure._changed("constant:" + name)
    except structure._Refusal as refusal:
        reason = (
            KeyframeStructureReason.UNPARSABLE
            if refusal.reason is structure.StructureReason.UNPARSABLE
            else KeyframeStructureReason.CHANGED
        )
        return NativeKeyframeStructureVerdict(reason, refusal.check, manifest.fingerprint)
    except RecursionError:
        return NativeKeyframeStructureVerdict(
            KeyframeStructureReason.UNPARSABLE, "source_depth_limit", manifest.fingerprint
        )
    return NativeKeyframeStructureVerdict(
        KeyframeStructureReason.ADMITTED, "admitted", manifest.fingerprint
    )


def classify_native_keyframe_source(content: bytes) -> NativeKeyframeStructureVerdict:
    return _classify(content, PRODUCTION_MANIFEST)


def is_production_admission(value: object) -> bool:
    return (
        type(value) is NativeKeyframeStructureVerdict
        and value.admitted
        and value.classifier_schema == NATIVE_KEYFRAME_CLASSIFIER_SCHEMA
        and value.manifest_fingerprint == PRODUCTION_MANIFEST.fingerprint
    )


def derive_keyframe_manifest(
    content: bytes, *, source_revision: str, source_blob: str, definitions: tuple[str, ...]
) -> NativeKeyframeBaselineManifest:
    """Maintainer/test derivation only; production admission accepts no external table."""
    raw = structure.derive_manifest(
        content,
        source_revision=source_revision,
        source_blob=source_blob,
        definitions=definitions,
        mask_keyframes=False,
    )
    return NativeKeyframeBaselineManifest(**asdict(raw))
