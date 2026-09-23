from __future__ import annotations

import pytest

from graite.retrieval.followup import decide

TEXTS = [
    "We decided on 20 euro per seat after the workshop in March.",
    "Atlas is the prototype. See Pricing for the seat price.",
]
HISTORY = [
    {"role": "user", "content": "What is the seat price?"},
    {"role": "assistant", "content": "Twenty euro per seat, decided after the March workshop [1]."},
]


@pytest.mark.parametrize(
    ("question", "retrieve"),
    [
        ("Why was that decided?", False),
        ("Can you make it shorter?", False),
        ("What was decided about the seat price in the workshop?", False),
        ("What colour did we paint the office walls?", True),
        ('Where is "cobalt" mentioned?', True),
        ("What happened on 2026-03-01?", True),
        ("Who owns ticket ATLAS-42?", True),
    ],
)
def test_follow_ups_reuse_and_new_topics_search(question: str, retrieve: bool) -> None:
    assert decide(question, HISTORY, TEXTS).retrieve is retrieve


def test_first_turn_always_searches() -> None:
    assert decide("Why?", [], TEXTS).retrieve
    assert decide("Why?", [HISTORY[0]], []).retrieve
    assert decide("Why?", [HISTORY[0]], TEXTS).retrieve  # no answer yet to build on
