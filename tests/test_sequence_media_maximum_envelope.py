"""Measure the final closed private envelope with synthetic maximum fields only."""

from dataclasses import replace
from typing import cast

from test_frame_mode_sequence_start import frame_start_fixture
from test_sequence_media_bindings import binding_wire

from comfyui_h3_context.adapters import managed_sequence_service as service_module
from comfyui_h3_context.adapters.sequence_media_bindings import SequenceMediaBindingSetV1
from comfyui_h3_context.core.canonical import canonical_bytes, canonical_fingerprint
from comfyui_h3_context.core.managed_sequence import (
    MAX_PREPARED_CONTEXT_RESPONSE_BYTES,
    EligibleSegmentExecutionV1,
)
from comfyui_h3_context.core.registry import build_reference_registry


def test_maximum_closed_frame_prepared_envelope_remains_inside_unchanged_caps() -> None:
    service, request, qualification, bindings, *_ = frame_start_fixture()
    started = service.start(replace(request, media_bindings=bindings), qualification=qualification)
    segment_id = (
        cast(service_module._ServiceEntry, service._entry)
        .sequence.authorization.segments[0]
        .segment_id
    )
    prepared = service.prepare_child(
        service_module.PrepareManagedSequenceChildRequestV1(
            request_id="prepare.maximum",
            parent_sequence_id=started.parent_sequence_id,
            expected_revision=started.revision,
            authorization_fingerprint=started.authorization_fingerprint,
            segment_id=segment_id,
            predecessor_terminal_fingerprint=None,
        )
    )
    execution = cast(EligibleSegmentExecutionV1, prepared.execution)
    read = service_module.ReadManagedPreparedContextRequestV1(
        request_id="read.maximum",
        parent_sequence_id=prepared.parent_sequence_id,
        expected_revision=prepared.revision,
        authorization_fingerprint=prepared.authorization_fingerprint,
        segment_id=segment_id,
        eligible_execution_fingerprint=execution.fingerprint,
        materialization_receipt_fingerprint=execution.materialization_receipt_fingerprint,
        context_workspace_handle=cast(str, prepared.context_workspace_handle),
    )
    value = cast(service_module.ManagedPreparedContextV2, service.read_prepared_child_context(read))
    entries, references = [], []
    for index, reference in enumerate(value.ordered_references):
        entry = binding_wire(index, maximum=True)
        entry["role"] = reference.role.value
        entry["registry_endpoint"]["input_name"] = reference.role.value
        entries.append(entry)
        references.append(replace(reference, asset_id=entry["asset_id"]))
    maximum_bindings = SequenceMediaBindingSetV1.from_wire(
        {"schema": "h3.context.sequence_media_binding_set.v1", "entries": entries}
    )
    prompt = "\U0001f31f" * 4096
    maximum = replace(
        value,
        parent_sequence_id="p" * 128,
        segment_id="s" * 128,
        context_report_id="r" * 128,
        context_workspace_handle="ws_" + "w" * 96,
        canonical_prompt=prompt,
        canonical_prompt_fingerprint=canonical_fingerprint(prompt),
        ordered_references=tuple(references),
        reference_registry_fingerprint=canonical_fingerprint(
            build_reference_registry(references).to_wire()
        ),
        media_bindings=maximum_bindings,
    )
    wire = maximum.to_wire()
    entry_sizes = [len(canonical_bytes(entry)) for entry in entries]
    response_size = len(canonical_bytes(wire))
    assert all(size <= 4096 for size in entry_sizes)
    assert response_size <= MAX_PREPARED_CONTEXT_RESPONSE_BYTES == 32768
    assert len(prompt) == 4096 and len(prompt.encode()) == 16384
    assert all(
        len(entry["locator"]) == 512 and len(entry["locator"].encode()) == 2048 for entry in entries
    )
    assert all(
        len(entry["asset_id"])
        == len(entry["loader_node_id"])
        == len(entry["transform"]["node_id"])
        == 128
        for entry in entries
    )
    assert prompt not in repr(maximum) and "locator" not in repr(maximum)
    # Content-free measurements only; no private execution envelope is printed or persisted.
    print("maximum_entry_bytes", entry_sizes, "maximum_frame_prepared_bytes", response_size)
