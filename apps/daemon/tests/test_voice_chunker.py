from __future__ import annotations

from graite.voice.chunker import SpeechChunker, speakable


def stream(text: str, size: int = 3) -> list[str]:
    chunker = SpeechChunker()
    out: list[str] = []
    for i in range(0, len(text), size):
        out += chunker.feed(text[i : i + size])
    return out + chunker.flush()


def test_sentences_come_out_as_soon_as_they_are_complete() -> None:
    chunker = SpeechChunker()
    assert chunker.feed("The deadline is next Friday. Anna still") == [
        "The deadline is next Friday."
    ]
    assert chunker.feed(" has to review it.") == []  # the end may still grow ("it.5")
    assert chunker.flush() == ["Anna still has to review it."]


def test_short_openers_join_the_next_sentence_and_decimals_survive() -> None:
    assert stream("Sure. It costs 3.5 euro per seat. Anything else?") == [
        "Sure. It costs 3.5 euro per seat.",
        "Anything else?",
    ]


def test_markdown_citations_links_and_reasoning_are_not_spoken() -> None:
    text = (
        "<think>Look at pricing first.</think>**Twenty euro** per seat [1], see "
        "[[Projects/Pricing|the pricing page]] or https://example.com/x.\n\n"
        "- First point [2, 3]\n- Second point\n```py\nprint(1)\n```\nDone then, that is all."
    )
    spoken = " ".join(stream(text, 4))
    assert spoken == (
        "Twenty euro per seat, see the pricing page or. First point. Second point. "
        "Done then, that is all."
    )
    assert speakable("CLARIFY: Which project do you mean?") == "Which project do you mean?"


def test_reset_forgets_text_streamed_before_a_tool_call() -> None:
    chunker = SpeechChunker()
    chunker.feed("Let me look that up for you")
    chunker.reset()
    assert chunker.feed("You have three notes about Atlas. ") == []
    assert chunker.flush() == ["You have three notes about Atlas."]


def test_long_sentences_are_split_at_commas() -> None:
    long = "First " + ", then another thing".join(str(i) for i in range(30)) + "."
    parts = stream(long, 7)
    assert len(parts) > 1 and all(len(p) <= 240 for p in parts)
    assert " ".join(parts).replace(" ", "") == long.replace(" ", "")


def test_the_first_thing_said_may_stop_at_a_clause_to_cut_the_wait() -> None:
    chunker = SpeechChunker()
    text = "The Atlas project launch deadline is Friday, the twenty-fifth of September, and Anna"
    out: list[str] = []
    for word in text.split(" "):
        out += chunker.feed(word + " ")
    assert out == ["The Atlas project launch deadline is Friday,"]
    assert chunker.feed("reviews the budget first. Then") == [
        "the twenty-fifth of September, and Anna reviews the budget first."
    ]


def test_bracketed_references_are_not_read_out() -> None:
    assert (
        speakable("I noted that in your journal [Ada/Journal].") == "I noted that in your journal."
    )


def test_tool_markup_the_server_failed_to_parse_is_never_spoken() -> None:
    """What the user actually heard: llama.cpp left a GLM-dialect call in the text, and the
    only cleaner that looked at it stripped the underscores and read out the tags."""
    leak = (
        "Sure, adding that now. <tool_call>propose_append"
        "<arg_key>path</arg_key><arg_value>Todos</arg_value></tool_call>"
    )
    spoken = " ".join(stream(leak, 4))
    assert spoken == "Sure, adding that now."
    for marker in ("tool", "arg_key", "arg_value", "<", ">"):
        assert marker not in spoken


def test_an_unfinished_tool_call_holds_everything_after_its_opener() -> None:
    """The stream may stop anywhere; nothing after the opener is trustworthy until it closes."""
    chunker = SpeechChunker()
    assert chunker.feed("Here you go, adding that now. <tool_call>propose_append<arg") == []
    assert chunker.flush() == ["Here you go, adding that now."]


def test_a_partial_opening_marker_never_leaks_while_the_call_arrives() -> None:
    """`<tool_c` may still become `<tool_call>`, so holding it back is what stops the leak."""
    chunker = SpeechChunker()
    spoken: list[str] = []
    for piece in ("All done with that one now. ", "<tool_c", "all>propose_append", "</tool_call>"):
        spoken += chunker.feed(piece)
    spoken += chunker.flush()
    assert spoken == ["All done with that one now."]


def test_fillers_are_already_plain_speech_and_leave_the_chunker_alone() -> None:
    """Fillers skip the chunker (they are queued whole), so they must need no cleaning, and
    the answer after a tool round still starts from a clean chunker."""
    from graite.voice.fillers import FILLERS

    for table in FILLERS.values():
        for phrases in table.values():
            for phrase in phrases:
                assert speakable(phrase) == phrase and phrase[-1] in ".!?…"
    chunker = SpeechChunker()
    assert chunker.feed("Let me see, ") == []  # half a clause before the model chose a tool
    chunker.reset()  # the tool round
    assert chunker.feed("Atlas has three notes. ") + chunker.flush() == ["Atlas has three notes."]
