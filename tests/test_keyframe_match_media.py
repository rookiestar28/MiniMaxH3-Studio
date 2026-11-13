"""Pinned 64-wide matching stays separate from the existing 96-wide seam metric."""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import cast

import pytest

from comfyui_h3_context.adapters import keyframe_match_media as media
from comfyui_h3_context.adapters.media_subprocess import (
    MediaProcessInvocation,
    ProcessCapture,
    ProcessStatus,
)
from comfyui_h3_context.adapters.seam_observation_media import LUMA_WIDTH as SEAM_WIDTH


@contextmanager
def _pin(*_args: object) -> Iterator[None]:
    yield


class _Runner:
    def __init__(self, body: bytes, status: ProcessStatus = ProcessStatus.SUCCEEDED) -> None:
        self.body, self.status = body, status
        self.invocations: list[MediaProcessInvocation] = []

    def run(self, invocation: MediaProcessInvocation) -> ProcessCapture:
        self.invocations.append(invocation)
        return ProcessCapture(status=self.status, stdout=self.body)


def _decoder(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    body: bytes,
    status: ProcessStatus = ProcessStatus.SUCCEEDED,
) -> media.KeyframeMatchDecoder:
    monkeypatch.setattr(media, "pin_exact_executable", _pin)
    binary = tmp_path / "ffmpeg.exe"
    binary.write_bytes(b"synthetic pin double")
    decoder = media.KeyframeMatchDecoder(binary)
    monkeypatch.setattr(decoder, "_runner", _Runner(body, status))
    return decoder


def test_luma_mae_uses_every_pixel_and_preserves_the_96_wide_reader() -> None:
    assert media.LUMA_WIDTH == 64 and SEAM_WIDTH == 96
    assert media.mean_absolute_luma_difference(b"\x00\xff", b"\xff\x00") == 255
    assert media.mean_absolute_luma_difference(b"\x01\x03\x05\x07", b"\x00\x00\x00\x00") == 4
    assert media.mean_absolute_luma_difference(b"\x10" * 64, b"\x10" * 64) == 0
    for left, right in [(b"", b""), (b"\x00", b"\x00\x00"), (bytearray(b"\x00"), b"\x00")]:
        with pytest.raises(media.KeyframeMatchMediaError, match="extent"):
            media.mean_absolute_luma_difference(cast(bytes, left), right)


def test_video_reader_measures_first_and_last_displayed_frames_at_64(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "segment.mp4"
    source.write_bytes(b"synthetic")
    body = b"\x10" * (64 * 36) + b"\x20" * (64 * 36)
    decoder = _decoder(monkeypatch, tmp_path, body)
    decoded = decoder.video_frames(source, source_width=864, source_height=480, frames=2)
    assert (decoded.width, decoded.height, len(decoded.frames)) == (64, 36, 2)
    assert media.mean_absolute_luma_difference(decoded.frames[0], decoded.frames[-1]) == 16
    invocation = cast(_Runner, decoder._runner).invocations[0]
    assert "scale=64:36:flags=area,format=gray" in invocation.argv
    assert invocation.protocol_whitelist == ("file",) and invocation.format_whitelist == ("mov",)
    assert invocation.max_stdout_bytes == len(body)
    assert body.hex() not in repr(decoded)


def test_reference_reader_uses_the_declared_native_crop_before_downsampling(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "reference.png"
    source.write_bytes(b"synthetic")
    decoder = _decoder(monkeypatch, tmp_path, b"\x30" * (64 * 64))
    frame = decoder.image_frame(source, source_width=128, source_height=64, crop=(32, 0, 64, 64))
    assert (frame.width, frame.height, len(frame.frames)) == (64, 64, 1)
    invocation = cast(_Runner, decoder._runner).invocations[0]
    assert "crop=64:64:32:0,scale=64:64:flags=area,format=gray" in invocation.argv
    assert invocation.format_whitelist == ("png_pipe",) and invocation.codec_whitelist == (
        "png",
        "rawvideo",
    )
    assert "-frames:v" in invocation.argv and invocation.max_stdout_bytes == 4096


@pytest.mark.parametrize("difference", [-1, 1])
def test_video_reader_refuses_short_and_long_decodes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, difference: int
) -> None:
    source = tmp_path / "segment.mp4"
    source.write_bytes(b"synthetic")
    decoder = _decoder(monkeypatch, tmp_path, b"\x00" * (64 * 36 + difference))
    with pytest.raises(media.KeyframeMatchMediaError, match="frame_count"):
        decoder.video_frames(source, source_width=864, source_height=480, frames=1)


def test_reader_refuses_output_limit_and_invalid_extents_before_spawn(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "segment.mp4"
    source.write_bytes(b"synthetic")
    decoder = _decoder(monkeypatch, tmp_path, b"", ProcessStatus.OUTPUT_LIMIT)
    with pytest.raises(media.KeyframeMatchMediaError, match="frame_count"):
        decoder.video_frames(source, source_width=864, source_height=480, frames=1)
    before = len(cast(_Runner, decoder._runner).invocations)
    for frames in (0, -1, True, 4097):
        with pytest.raises(media.KeyframeMatchMediaError, match="extent"):
            decoder.video_frames(source, source_width=864, source_height=480, frames=frames)
    for crop in ((True, 0, 64, 64), (0, 0, 31, 64), (96, 0, 64, 64)):
        with pytest.raises(media.KeyframeMatchMediaError, match="geometry"):
            decoder.image_frame(source, source_width=128, source_height=64, crop=crop)
    assert len(cast(_Runner, decoder._runner).invocations) == before
