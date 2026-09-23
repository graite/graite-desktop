"""The page tree the assistant navigates by, instead of having pages pushed at it."""

from graite.retrieval import navigation

PATHS = [
    "Journal",
    "Projects",
    "Projects/Atlas",
    "Projects/Atlas/Roadmap",
    "Welcome",
]
TITLES = {
    "Journal": "Journal",
    "Projects": "Projects",
    "Projects/Atlas": "Atlas",
    "Projects/Atlas/Roadmap": "Q3 Roadmap",
    "Welcome": "Welcome",
}


def _body(text: str) -> list[str]:
    return text.split("\n")[1:]


def test_renders_nesting_as_indentation_and_names_a_differing_title():
    body = _body(navigation.render(PATHS, TITLES, 4000))
    assert body == [
        "Journal",
        "Projects",
        "  Atlas",
        "    Roadmap (Q3 Roadmap)",
        "Welcome",
    ]


def test_header_points_at_the_tools_rather_than_loading_anything():
    text = navigation.render(PATHS, TITLES, 4000)
    for tool in ("read_page", "search_vault", "list_children"):
        assert tool in text
    assert "Nothing below is loaded" in text


def test_collapses_the_deepest_branches_when_it_does_not_fit():
    wide = [f"Projects/Atlas/Note {i}" for i in range(40)]
    text = navigation.render([*PATHS, *wide], TITLES, 700)
    assert len(text.encode()) <= 700
    assert "Atlas/ — 41 more" in text
    assert "Roadmap" not in text


def test_an_empty_scope_renders_nothing():
    assert navigation.render([], {}, 4000) == ""


def test_says_nothing_rather_than_half_an_explanation_on_a_tiny_budget():
    assert navigation.render(PATHS, TITLES, len(navigation.HEADER.encode())) == ""


def test_many_top_level_pages_fit_without_cutting_a_path_in_half():
    paths = [f"Project {i:03}" for i in range(300)]
    text = navigation.render(paths, {}, 700)
    assert len(text.encode()) <= 700
    assert "Some top-level pages are omitted" in text
    assert "list_children(path='', offset=0)" in text
    assert all(line in paths for line in text.splitlines()[1:-1])


def test_spoken_name_and_correction_resolve_against_available_pages():
    titles = {"Graite": "Graite", "Todos": "Todos"}
    request = "Mostly about all the actions that I still have to do for grade."
    paths, hint = navigation.page_reference(request, [], titles, voice=True)
    assert paths == ["Graite"] and "possible transcription mismatch" in hint
    history = [{"role": "user", "content": request}]
    correction = "It's great, like G-R-A-I-T-E."
    paths, hint = navigation.page_reference(correction, history, titles, voice=True)
    assert paths == ["Graite"] and "spelled name" in hint and request in hint
    history.append({"role": "user", "content": correction})
    paths, hint = navigation.page_reference(
        "Can you tell me all the actions that are open still?", history, titles, voice=True
    )
    assert paths == ["Graite"] and "recent user message" in hint


def test_ambiguous_page_names_are_not_silently_reduced_to_one():
    titles = {"Work/Atlas": "Atlas", "Home/Atlas": "Atlas"}
    paths, _ = navigation.page_reference("Open tasks for Atlas?", [], titles, voice=True)
    assert set(paths) == set(titles)


def test_small_talk_and_assistant_guesses_do_not_trigger_page_reads():
    titles = {"Graite": "Graite"}
    history = [{"role": "assistant", "content": "Maybe you mean Graite?"}]
    assert navigation.page_reference("Which actions are open?", history, titles, voice=True) == (
        [],
        "",
    )
    history = [{"role": "user", "content": "Open tasks on Graite?"}]
    assert navigation.page_reference("Thanks Graite!", history, titles, voice=True) == ([], "")
    assert navigation.page_reference("Tasks for grade?", [], titles, voice=False) == ([], "")
    # Only accessible titles are passed to the resolver: no inferred or invented paths.
    assert navigation.page_reference("Tasks for G-R-A-I-T-E?", [], {}, voice=True) == ([], "")
