"""The daemon's copy of the fence rules, pinned to the converter's own corpus.

A `graite:view` fence the editor cannot parse becomes plain grey text, so a model that invents
one key silently ships a page that looks nothing like the board the user asked for. These cases
are the same file packages/md-convert/src/blocks.test.ts reads.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from graite.vault.blocks import check_fences

CASES = json.loads(
    (
        Path(__file__).resolve().parents[3] / "packages/md-convert/fixtures/view-cases.json"
    ).read_text()
)


def fence(body: str) -> str:
    return f"Some text.\n\n```graite:view\n{body}```\n"


@pytest.mark.parametrize("body", CASES["valid"])
def test_bodies_the_converter_accepts_are_not_refused(body: str) -> None:
    assert check_fences(fence(body)) is None


@pytest.mark.parametrize("body", CASES["invalid"])
def test_bodies_the_converter_would_drop_are_refused_by_name(body: str) -> None:
    problem = check_fences(fence(body))
    assert problem, f"would silently become plain text: {body!r}"


def test_the_message_names_the_key_so_the_model_can_fix_it() -> None:
    assert "groupBy" in str(check_fences(fence("view: kanban\ngroupBy: Status\n")))
    assert "timeline" in str(check_fences(fence("view: timeline\n")))


def test_a_plain_code_block_is_never_inspected() -> None:
    assert check_fences("```py\nview: nonsense\n```\n") is None
    assert check_fences("No fences here at all.") is None


def test_a_broken_columns_fence_is_refused_too() -> None:
    assert check_fences("```graite:columns\ncolumns:\n  - only one\n```\n")
    assert check_fences("```graite:columns\ncolumns:\n  - a\n  - b\n```\n") is None
