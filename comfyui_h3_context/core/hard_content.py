"""The literal content predicate shared by validation and assisted proposals."""

from __future__ import annotations

from collections.abc import Sequence

REQUIRED_CONTENT_LOST = "constraint.required_content_lost"
FORBIDDEN_CONTENT_PRESENT = "constraint.forbidden_content_present"


def hard_content_violations(
    required: Sequence[str], forbidden: Sequence[str], text: str
) -> tuple[tuple[str, int], ...]:
    """Return fixed identities and collection indexes, never caller-owned values.

    Match lint's case-sensitive substring semantics, without normalization or tokenization.
    Indexes refer to the required or forbidden collection selected by the identity.
    """

    return tuple(
        (REQUIRED_CONTENT_LOST, index) for index, value in enumerate(required) if value not in text
    ) + tuple(
        (FORBIDDEN_CONTENT_PRESENT, index) for index, value in enumerate(forbidden) if value in text
    )
