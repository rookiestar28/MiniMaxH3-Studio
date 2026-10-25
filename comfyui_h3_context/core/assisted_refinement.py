"""Bounded user direction for the existing server-owned prose drafting action."""

import re
import unicodedata
from dataclasses import dataclass

MAX_REVISION_INSTRUCTION_SCALARS = 2_048
MAX_REVISION_INSTRUCTION_BYTES = 8_192


@dataclass(frozen=True, slots=True)
class RequestedAllowance:
    """Content-free category grants for this action, never a replacement for typed facts."""

    camera_motion: bool = False
    cut: bool = False


_MOTION_REQUEST = re.compile(
    r"\b(?:zoom|push|pull|pan|truck|tilt|pedestal|shake|roll)(?:s|es|ing)?\s+"
    r"(?:in|out|left|right|up|down|slightly|strongly|clockwise|counterclockwise)\b"
    r"|\b(?:arc shot|tracking shot|camera mov(?:e|es|ement)|track(?:ing)?|zoom)\b"
)
_CUT_REQUEST = re.compile(
    r"\b(?:cuts?|transitions?|dissolves?|cross\s+dissolve)\b"
    r"|\bthe shot (?:changes|switches) to\b"
)
_CHINESE_MOTION_REQUESTS = (
    "推鏡",
    "推镜",
    "拉鏡",
    "拉镜",
    "推近",
    "拉遠",
    "拉远",
    "平移",
    "橫搖",
    "横摇",
    "搖鏡",
    "摇镜",
    "俯仰",
    "上仰",
    "下俯",
    "跟拍",
    "追蹤",
    "追踪",
    "變焦",
    "变焦",
    "運鏡",
    "运镜",
    "鏡頭移動",
    "镜头移动",
)
_CHINESE_CUT_REQUESTS = (
    "剪接",
    "剪輯",
    "剪辑",
    "切鏡",
    "切镜",
    "切換鏡頭",
    "切换镜头",
    "轉場",
    "转场",
    "轉換鏡頭",
    "转换镜头",
    "溶接",
    "溶解",
    "疊化",
    "叠化",
    "交叉淡化",
    "淡入淡出",
)


def requested_allowance_from_instruction(instruction: str) -> RequestedAllowance:
    """Read only the closed camera/cut lexicon from an already bounded instruction."""

    text = unicodedata.normalize("NFKC", validate_revision_instruction(instruction)).casefold()
    text = re.sub(r"[-_‐‑‒–—−]", " ", text)
    # IMPORTANT: instruction grants apply only to these two warning categories. Never feed
    # instruction text into constraint, role, duration or exact-span checks to relax them.
    return RequestedAllowance(
        camera_motion=bool(_MOTION_REQUEST.search(text))
        or any(term in text for term in _CHINESE_MOTION_REQUESTS),
        cut=bool(_CUT_REQUEST.search(text)) or any(term in text for term in _CHINESE_CUT_REQUESTS),
    )


def validate_revision_instruction(value: object) -> str:
    """Preserve valid Unicode verbatim; refusals never echo supplied content."""

    if (
        type(value) is not str
        or not value.strip()
        or len(value) > MAX_REVISION_INSTRUCTION_SCALARS
        or "\x00" in value
        or any(0xD800 <= ord(char) <= 0xDFFF for char in value)
        or len(value.encode("utf-8")) > MAX_REVISION_INSTRUCTION_BYTES
    ):
        raise ValueError("revision instruction is invalid")
    return value
