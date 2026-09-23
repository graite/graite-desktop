"""Turning what a small local model writes into properties a board can actually group by."""

from __future__ import annotations

import pytest

from graite.vault.properties import PageProperty, from_compact, merge, merge_definitions


def prop(name: str, kind: str, **kw: object) -> PageProperty:
    return PageProperty(id=name.lower(), name=name, type=kind, **kw)  # type: ignore[arg-type]


def test_a_minimal_card_becomes_a_groupable_status_field() -> None:
    [status] = from_compact(
        [{"name": "Status", "type": "status", "options": ["To do", "Done"], "value": "To do"}]
    )
    assert (status.id, status.type, status.value) == ("status", "status", "To do")
    # Board columns are only offered for status/single_select, and colours must be stable.
    assert status.colors == {"To do": "gray", "Done": "green"}


def test_a_value_outside_the_options_adds_the_column_instead_of_failing() -> None:
    """The commonest mistake by far. Refusing would lose the whole proposal over a column
    the model plainly meant to exist."""
    [status] = from_compact(
        [{"name": "Status", "type": "status", "options": ["To do"], "value": "In progress"}]
    )
    assert status.options == ["To do", "In progress"]
    assert status.value == "In progress"


def test_the_type_is_inferred_when_the_model_leaves_it_out() -> None:
    kinds = {
        p.name: p.type
        for p in from_compact(
            [
                {"name": "Done", "value": True},
                {"name": "Estimate", "value": 3},
                {"name": "Due", "value": "2026-10-02"},
                {"name": "Status", "options": ["Open"], "value": "Open"},
                {"name": "Priority", "options": ["High"], "value": "High"},
                {"name": "Notes", "value": "anything"},
            ]
        )
    }
    assert kinds == {
        "Done": "checkbox",
        "Estimate": "number",
        "Due": "date",
        "Status": "status",
        "Priority": "single_select",
        "Notes": "text",
    }


def test_a_new_card_inherits_the_board_options_and_never_narrows_them() -> None:
    """Each card carries the whole definition, so one forgetful card must not shrink the board."""
    board = [
        prop("Status", "status", options=["To do", "In progress", "Done"], colors={"Done": "pink"})
    ]
    [status] = from_compact([{"name": "status", "value": "Done"}], board)
    assert status.options == ["To do", "In progress", "Done"]
    assert status.id == "status"  # matched by name, so the card joins the existing column
    assert status.colors["Done"] == "pink"  # the board's own colour wins over the default


def test_string_values_are_coerced_for_typed_fields() -> None:
    fields = {
        p.name: p.value
        for p in from_compact(
            [
                {"name": "Done", "type": "checkbox", "value": "true"},
                {"name": "Estimate", "type": "number", "value": "3"},
                {"name": "Tags", "type": "multi_select", "value": "urgent"},
            ]
        )
    }
    assert fields == {"Done": True, "Estimate": 3, "Tags": ["urgent"]}


def test_a_nameless_property_is_refused_in_words_the_model_can_act_on() -> None:
    with pytest.raises(ValueError, match="needs a name"):
        from_compact([{"type": "status", "value": "Done"}])


def test_merge_keeps_fields_nobody_mentioned() -> None:
    existing = [prop("Status", "status", options=["Done"], value="Done"), prop("Due", "date")]
    incoming = from_compact([{"name": "Status", "options": ["Done"], "value": "Done"}])
    names = [(p.name, p.value) for p in merge(existing, incoming)]
    assert names == [("Status", "Done"), ("Due", None)]


def test_merge_definitions_unions_options_across_cards_and_drops_values() -> None:
    cards = [
        [prop("Status", "status", options=["To do"], value="To do")],
        [prop("Status", "status", options=["Done"], value="Done")],
    ]
    [status] = merge_definitions(cards)
    assert status.options == ["To do", "Done"]
    assert status.value is None
