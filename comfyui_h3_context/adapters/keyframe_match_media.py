"""Pinned 64-wide luma frames for declared-image and generated-frame matching.

This measurement adapter keeps the existing 96-wide seam metric unchanged. It retains
pixels only in memory and reports closed failure codes rather than source paths.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Final

from .executable_admission import ExecutableAdmissionError, pin_exact_executable
from .media_subprocess import MediaProcessInvocation, ProcessStatus, SubprocessMediaRunner
from .seam_observation_media import scaled_height, seam_observation_binary_capability

LUMA_WIDTH: Final = 64
_MAX_DIMENSION: Final = 16_384
_MAX_FRAMES: Final = 4096
_MAX_DECODE_BYTES: Final = 64 * 1024 * 1024


class KeyframeMatchMediaError(RuntimeError):
    """A closed measurement failure code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise KeyframeMatchMediaError(code)


@dataclass(frozen=True, slots=True)
class KeyframeMatchFrames:
    width: int
    height: int
    frames: tuple[bytes, ...] = field(repr=False)


def mean_absolute_luma_difference(left: bytes, right: bytes) -> float:
    """Mean absolute difference in raw 0..255 luma units, over every pixel."""

    _require(type(left) is bytes and type(right) is bytes and 0 < len(left) == len(right), "extent")
    return sum(abs(a - b) for a, b in zip(left, right, strict=True)) / len(left)


class KeyframeMatchDecoder:
    """Decode bounded MP4 sequences and PNG references with the same pinned FFmpeg."""

    def __init__(self, ffmpeg_path: Path) -> None:
        _require(isinstance(ffmpeg_path, Path) and ffmpeg_path.is_absolute(), "unsupported")
        self._digest = seam_observation_binary_capability().ffmpeg_sha256
        try:
            with pin_exact_executable(ffmpeg_path, self._digest):
                pass
        except (ExecutableAdmissionError, OSError):
            raise KeyframeMatchMediaError("unsupported") from None
        self._ffmpeg = ffmpeg_path
        self._runner = SubprocessMediaRunner()

    @staticmethod
    def _dimensions(width: int, height: int) -> None:
        _require(
            all(type(value) is int and 0 < value <= _MAX_DIMENSION for value in (width, height)),
            "geometry",
        )

    def video_frames(
        self, source: Path, *, source_width: int, source_height: int, frames: int
    ) -> KeyframeMatchFrames:
        self._dimensions(source_width, source_height)
        _require(type(frames) is int and 0 < frames <= _MAX_FRAMES, "extent")
        height = scaled_height(source_width, source_height, LUMA_WIDTH)
        return self._decode(source, height, frames, crop=None, image=False)

    def image_frame(
        self,
        source: Path,
        *,
        source_width: int,
        source_height: int,
        crop: tuple[int, int, int, int] | None = None,
    ) -> KeyframeMatchFrames:
        self._dimensions(source_width, source_height)
        if crop is not None:
            _require(
                type(crop) is tuple
                and len(crop) == 4
                and all(type(value) is int for value in crop),
                "geometry",
            )
            x, y, width, height = crop
            _require(
                x >= 0
                and y >= 0
                and width >= 32
                and height >= 32
                and x + width <= source_width
                and y + height <= source_height,
                "geometry",
            )
        else:
            width, height = source_width, source_height
        return self._decode(
            source, scaled_height(width, height, LUMA_WIDTH), 1, crop=crop, image=True
        )

    def _decode(
        self,
        source: Path,
        height: int,
        frames: int,
        *,
        crop: tuple[int, int, int, int] | None,
        image: bool,
    ) -> KeyframeMatchFrames:
        expected_bytes = LUMA_WIDTH * height * frames
        _require(expected_bytes <= _MAX_DECODE_BYTES, "extent")
        try:
            _require(
                isinstance(source, Path) and source.is_absolute() and source.is_file(), "source"
            )
        except OSError:
            raise KeyframeMatchMediaError("source") from None
        demuxer = "png_pipe" if image else "mov"
        codecs = ("png", "rawvideo") if image else ("h264", "aac", "rawvideo")
        filters = f"scale={LUMA_WIDTH}:{height}:flags=area,format=gray"
        if crop is not None:
            x, y, width, crop_height = crop
            filters = f"crop={width}:{crop_height}:{x}:{y}," + filters
        argv = (
            str(self._ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            demuxer,
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            filters,
            *(("-frames:v", "1") if image else ()),
            "-c:v",
            "rawvideo",
            "-f",
            "rawvideo",
            "pipe:1",
        )
        invocation = MediaProcessInvocation(
            tool="ffmpeg",
            executable=str(self._ffmpeg),
            argv=argv,
            protocol_whitelist=("file",),
            format_whitelist=(demuxer,),
            codec_whitelist=codecs,
            timeout_seconds=Decimal(300),
            max_stdout_bytes=expected_bytes,
            max_stderr_bytes=256 * 1024,
        )
        try:
            with pin_exact_executable(self._ffmpeg, self._digest):
                capture = self._runner.run(invocation)
        except (ExecutableAdmissionError, OSError):
            raise KeyframeMatchMediaError("unsupported") from None
        if capture.status is ProcessStatus.OUTPUT_LIMIT:
            raise KeyframeMatchMediaError("frame_count")
        _require(
            capture.status is ProcessStatus.SUCCEEDED and capture.cleanup_succeeded, "decode_failed"
        )
        # IMPORTANT: do not truncate to the expected prefix. A missing or extra decoded frame
        # shifts first/last comparisons and can falsely certify a different generated interval.
        _require(len(capture.stdout) == expected_bytes, "frame_count")
        frame_bytes = LUMA_WIDTH * height
        return KeyframeMatchFrames(
            LUMA_WIDTH,
            height,
            tuple(
                capture.stdout[index * frame_bytes : (index + 1) * frame_bytes]
                for index in range(frames)
            ),
        )
