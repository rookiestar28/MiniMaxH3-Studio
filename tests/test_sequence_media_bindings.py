"""Closed private binding contracts; synthetic data never describes operator media."""

import importlib
import json
from copy import deepcopy
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from test_m23_18_input_geometry import _png, _registry, _request

from comfyui_h3_context.adapters.comfyui_input_geometry import GeometryPreflightError
from comfyui_h3_context.core.canonical import canonical_bytes


def binding_wire(index: int = 0, *, maximum: bool = False) -> dict[str, Any]:
    node = (lambda value: value + "n" * (128 - len(value))) if maximum else str
    return {
        "asset_id": node(f"asset{index}"),
        "role": "first_frame",
        "kind": "image",
        "loader_class": "LoadImage",
        "loader_node_id": node(f"loader{index}"),
        "locator": "\U0001f31f" * 512 if maximum else f"synthetic/source{index}.png",
        "source_identity": {
            "schema": "h3.context.input_geometry.receipt.v2",
            "receipt_handle": "ig_" + "r" * 96,
            "source_fingerprint": "sha256:" + "a" * 64,
        },
        "registry_endpoint": {
            "node_id": node("registry"),
            "input_name": node(f"image_{index}"),
            "source_node_id": node(f"crop{index}"),
            "source_slot": 0,
        },
        "transform": {
            "node_id": node(f"crop{index}"),
            "class_type": "ImageCropV2",
            "region": {"x": 16352, "y": 16352, "width": 32, "height": 32},
        },
    }


def set_wire(*, maximum: bool = False, count: int = 1) -> dict[str, Any]:
    return {
        "schema": "h3.context.sequence_media_binding_set.v1",
        "entries": [binding_wire(i, maximum=maximum) for i in range(count)],
    }


def module() -> ModuleType:
    return importlib.import_module("comfyui_h3_context.adapters.sequence_media_bindings")


def test_binding_closed_roundtrip_and_maximum_unicode_budget() -> None:
    m = module()
    wire = set_wire(maximum=True, count=3)
    decoded = m.SequenceMediaBindingSetV1.from_wire(wire)
    assert decoded.to_wire() == wire
    assert len(canonical_bytes(wire["entries"][0])) <= 4096
    assert len(canonical_bytes(wire)) <= 3 * 4096 + 128
    # Maximum+1 is refused independently of the unknown-member shape guard.
    oversized = binding_wire()
    oversized["locator"] = "x" * 4097
    with pytest.raises(m.SequenceMediaBindingError, match="sequence_media_binding_size"):
        m.SequenceMediaBindingV1.from_wire(oversized)
    assert "synthetic/source" not in repr(m.SequenceMediaBindingSetV1.from_wire(set_wire()))


@pytest.mark.parametrize(
    "change",
    ["extra", "kind", "loader", "chain", "region_extra", "bool", "sum", "small", "slot", "locator"],
)
def test_binding_codec_refuses_unknown_fields_classes_chains_and_crop_bounds(change: str) -> None:
    m = module()
    wire = set_wire()
    row = wire["entries"][0]
    if change == "extra":
        row["private_marker"] = True
    elif change == "kind":
        row["kind"] = "video"
    elif change == "loader":
        row["loader_class"] = "LoadVideo"
    elif change == "chain":
        row["transform"]["class_type"] = "ImageScale"
    elif change == "region_extra":
        row["transform"]["region"]["other"] = 1
    elif change == "bool":
        row["transform"]["region"]["x"] = True
    elif change == "sum":
        row["transform"]["region"]["x"] = 16353
    elif change == "small":
        row["transform"]["region"]["width"] = 31
    elif change == "slot":
        row["registry_endpoint"]["source_slot"] = 1
    elif change == "locator":
        row["locator"] = "../synthetic.png"
    with pytest.raises(m.SequenceMediaBindingError):
        m.SequenceMediaBindingSetV1.from_wire(wire)


def test_binding_identity_covers_topology_crop_source_but_not_ephemeral_receipt() -> None:
    m = module()
    wire = set_wire()
    original = m.SequenceMediaBindingSetV1.from_wire(wire)
    reobserved = deepcopy(wire)
    reobserved["entries"][0]["source_identity"]["receipt_handle"] = "ig_" + "s" * 40
    assert m.SequenceMediaBindingSetV1.from_wire(reobserved).fingerprint == original.fingerprint
    changes = []
    for field, value in [("locator", "synthetic/changed.png"), ("loader_node_id", "otherloader")]:
        changed = deepcopy(wire)
        changed["entries"][0][field] = value
        changes.append(changed)
    for field in ["node_id", "input_name"]:
        changed = deepcopy(wire)
        changed["entries"][0]["registry_endpoint"][field] = "changed"
        changes.append(changed)
    changed = deepcopy(wire)
    changed["entries"][0]["source_identity"]["source_fingerprint"] = "sha256:" + "b" * 64
    changes.append(changed)
    changed = deepcopy(wire)
    changed["entries"][0]["transform"]["region"]["x"] -= 1
    changes.append(changed)
    changed = deepcopy(wire)
    changed["entries"][0]["transform"] = None
    changed["entries"][0]["registry_endpoint"]["source_node_id"] = "loader0"
    changes.append(changed)
    for changed in changes:
        assert m.SequenceMediaBindingSetV1.from_wire(changed).fingerprint != original.fingerprint


def test_binding_retention_maximum_sets_capacity_expiry_release_and_no_pool_growth() -> None:
    from comfyui_h3_context.adapters.comfyui_sequence_coordinator import MAX_COORDINATOR_RUNS

    m = module()
    now = [100.0]
    pool = m.RetainedSequenceMediaBindings(clock=lambda: now[0])
    maximum = m.SequenceMediaBindingSetV1.from_wire(set_wire(maximum=True, count=3))
    assert m.MAX_SEQUENCE_MEDIA_PARENTS == MAX_COORDINATOR_RUNS == 16
    assert m.MAX_RETAINED_SEQUENCE_MEDIA_BYTES == 196608
    for i in range(MAX_COORDINATOR_RUNS):
        pool.retain(f"parent{i}", maximum, expires_at=200.0)
    assert pool.reserved_bytes == m.MAX_RETAINED_SEQUENCE_MEDIA_BYTES
    assert pool.parent_count == 16
    with pytest.raises(m.SequenceMediaBindingError, match="coordinator_run_capacity"):
        pool.retain("parent16", maximum, expires_at=200.0)
    assert pool.parent_count == 16 and pool.reserved_bytes == 196608
    assert pool.get("parent0") is maximum
    pool.release("parent0")
    pool.release("parent0")
    pool.retain("parent16", maximum, expires_at=200.0)
    now[0] = 200.0
    assert pool.parent_count == 0 and pool.reserved_bytes == 0
    with pytest.raises(m.SequenceMediaBindingError, match="sequence_media_unavailable"):
        pool.get("parent1")


def test_file_receipt_claim_is_bound_to_the_declared_locator(tmp_path: Path) -> None:
    root = tmp_path / "input"
    (root / "synthetic").mkdir(parents=True)
    for name in ["source.png", "other.png"]:
        (root / "synthetic" / name).write_bytes(_png(32, 32))
    registry = _registry(root)
    receipt = registry.observe(_request())
    with pytest.raises(GeometryPreflightError, match="geometry_receipt_mismatch"):
        registry.claim(receipt.to_wire(), locator="synthetic/other.png")
    receipt = registry.observe(_request())
    assert registry.claim(receipt.to_wire(), locator="synthetic/source.png") == receipt


def test_exact_locator_claim_rechecks_hardlink_safety(tmp_path: Path) -> None:
    import os

    root = tmp_path / "input"
    (root / "synthetic").mkdir(parents=True)
    source, alias = root / "source.png", root / "synthetic/source.png"
    source.write_bytes(_png(32, 32))
    alias.write_bytes(_png(32, 32))
    registry = _registry(root)
    receipt = registry.observe(_request())
    alias.unlink()
    os.link(source, alias)
    with pytest.raises(GeometryPreflightError, match="^input_unsafe$"):
        registry.claim(receipt.to_wire(), locator="synthetic/source.png")


def test_crop_dimension_is_equal_to_the_frontend_authority() -> None:
    import re

    source = (
        Path(__file__).resolve().parents[1] / "frontend/src/host/imageCropGeometry.ts"
    ).read_text()
    actual = re.search(r"MAX_CROP_DIMENSION = ([\d_]+)", source)
    assert actual is not None
    assert module().MAX_CROP_DIMENSION == int(actual[1].replace("_", ""))


def test_binding_identity_preserves_exact_locator_codepoints_and_raw_utf8_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    m = module()
    first, second = set_wire(), set_wire()
    first["entries"][0]["locator"] = "synthetic/\u00e9.png"
    second["entries"][0]["locator"] = "synthetic/e\u0301.png"
    assert (
        m.SequenceMediaBindingSetV1.from_wire(first).fingerprint
        != m.SequenceMediaBindingSetV1.from_wire(second).fingerprint
    )
    raw = json.dumps(second["entries"][0], ensure_ascii=False, separators=(",", ":")).encode()
    monkeypatch.setattr(m, "MAX_SEQUENCE_MEDIA_BINDING_BYTES", len(raw) - 1)
    with pytest.raises(m.SequenceMediaBindingError, match="sequence_media_binding_size"):
        m.SequenceMediaBindingSetV1.from_wire(second)
