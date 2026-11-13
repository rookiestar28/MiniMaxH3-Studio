"""Registered crop schema facts, independent of retained-contract positive doubles."""

import re
from pathlib import Path

import pytest
from test_sequence_media_bindings import module, set_wire


def test_retained_crop_matches_registered_native_schema_and_frontend_constant() -> None:
    # Read-only native nodes_images.py schema: ImageCropV2(image:IMAGE, crop_region:BOUNDING_BOX).
    # Source hash is recorded in the private implementation record; never import host code here.
    capability = (
        Path(__file__).resolve().parents[1] / "frontend/src/host/imageCropCapability.ts"
    ).read_text()
    registered = re.search(r'IMAGE_CROP_NODE_TYPE = "([^"]+)"', capability)
    assert registered is not None
    assert (
        getattr(module(), "SEQUENCE_MEDIA_CROP_NODE_TYPE", None) == registered[1] == "ImageCropV2"
    )
    assert 'IMAGE_CROP_REGION_TYPE = "BOUNDING_BOX"' in capability
    wire = set_wire()
    wire["entries"][0]["transform"]["class_type"] = registered[1]
    assert module().SequenceMediaBindingSetV1.from_wire(wire).to_wire() == wire


def test_invented_crop_class_is_not_an_alias() -> None:
    wire = set_wire()
    wire["entries"][0]["transform"]["class_type"] = "ImageCropByRegion"
    with pytest.raises(module().SequenceMediaBindingError, match="sequence_media_binding_invalid"):
        module().SequenceMediaBindingSetV1.from_wire(wire)
