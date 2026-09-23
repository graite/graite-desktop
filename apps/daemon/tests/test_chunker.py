from __future__ import annotations

from graite.index.chunker import chunk_page, extract_links, text_hash


def test_headings_become_heading_paths_and_sections() -> None:
    body = (
        "Intro paragraph that is long enough to stand on its own as a section of text. " * 4
        + "\n\n# Plan\n\n"
        + "First part of the plan with enough words to matter. " * 6
        + "\n\n## Pricing\n\n"
        + "We decided on 20 euro per seat after the workshop. " * 6
        + "\n\n# Notes\n\nShort.\n"
    )
    chunks = chunk_page("Roadmap", body)
    paths = [c.heading_path for c in chunks]
    assert paths[0] == []
    assert ["Plan"] in paths and ["Plan", "Pricing"] in paths
    assert all(
        c.text and "Pricing" not in c.text for c in chunks if c.heading_path == ["Plan", "Pricing"]
    )
    assert [c.ord for c in chunks] == list(range(len(chunks)))


def test_short_sibling_sections_merge() -> None:
    body = "# A\n\nTiny.\n\n# B\n\nAlso tiny.\n"
    chunks = chunk_page("Page", body)
    assert len(chunks) == 1
    assert "Tiny." in chunks[0].text and "# B" in chunks[0].text and "Also tiny." in chunks[0].text


def test_lists_stay_together_and_oversized_lists_split_with_overlap() -> None:
    small = "# Tasks\n\n" + "\n".join(f"- task {i} with a few words" for i in range(10)) + "\n"
    assert len(chunk_page("T", small)) == 1
    big = "# Tasks\n\n" + "\n".join(f"- task {i} " + "x" * 90 for i in range(40)) + "\n"
    chunks = chunk_page("T", big)
    assert len(chunks) > 1
    assert all(c.kind == "list" for c in chunks)
    first_last = chunks[0].text.splitlines()[-1]
    assert first_last in chunks[1].text  # two-item overlap


def test_view_fences_are_skipped_and_columns_are_chunked() -> None:
    body = (
        "```graite:view\nview: table\n```\n\n"
        "```graite:columns\ncolumns:\n  - '## Left\n\n    left text'\n  - right text\n```\n"
    )
    chunks = chunk_page("Board", body)
    joined = " ".join(c.text for c in chunks)
    assert "view: table" not in joined
    assert "left text" in joined and "right text" in joined


def test_chunks_are_deterministic_and_hash_includes_title() -> None:
    body = "# H\n\nSome text about apples and pears that repeats a bit. " * 5
    a, b = chunk_page("Fruit", body), chunk_page("Fruit", body)
    assert [(c.text, c.heading_path) for c in a] == [(c.text, c.heading_path) for c in b]
    assert text_hash("Fruit", ["H"], a[0].text) != text_hash("Veg", ["H"], a[0].text)


def test_empty_page_yields_one_title_chunk() -> None:
    chunks = chunk_page("Only a title", "")
    assert len(chunks) == 1 and chunks[0].kind == "title" and chunks[0].text == ""


def test_links_and_tags_are_extracted_but_not_from_code() -> None:
    body = (
        "See [[Projects/Atlas#Roadmap|the plan]] and ![[_assets/pic.png]] and [doc](notes.md).\n"
        "Tagged #planning and #q3/pricing but not `#code` nor http://x.y/#frag nor #123.\n"
        "```\n[[not a link]] #nottag\n```\n# Heading #notatag\n"
    )
    links = extract_links(body)
    kinds = {(link.kind, link.target) for link in links}
    assert ("wiki", "Projects/Atlas") in kinds and ("embed", "_assets/pic.png") in kinds
    assert ("md", "notes.md") in kinds
    assert ("tag", "planning") in kinds and ("tag", "q3/pricing") in kinds
    assert ("tag", "code") not in kinds and ("tag", "frag") not in kinds
    assert ("wiki", "not a link") not in kinds and ("tag", "nottag") not in kinds
    assert ("tag", "notatag") not in kinds
    wiki = next(link for link in links if link.kind == "wiki")
    assert wiki.heading == "Roadmap" and wiki.alias == "the plan"
