"""Short spoken fillers for the silence while the assistant uses a tool.

A search or a page read can take seconds with nothing to hear; on a voice call that sounds
like a dropped line. The session says one of these the moment the first tool starts (when
nothing of the answer has been said yet), and "still looking" once if a tool round drags on.

Phrases are grouped by what the tool does and rotate so the assistant does not repeat itself
word for word. Languages without a table fall back to English.
"""

from __future__ import annotations

from itertools import count

FILLERS: dict[str, dict[str, tuple[str, ...]]] = {
    "en": {
        "search": ("Let me check your pages.", "Let me look that up.", "One moment, searching."),
        "read": ("Let me look at that page.", "Let me read that.", "Opening that page."),
        "propose": ("I'll prepare that change.", "Let me set that up.", "Preparing that now."),
        "other": ("One moment.", "Just a second.", "Let me see."),
        "still": ("Still looking.", "Almost there.", "Bear with me."),
    },
    "nl": {
        "search": (
            "Even in je pagina's kijken.",
            "Ik zoek het even op.",
            "Momentje, ik zoek het op.",
        ),
        "read": ("Ik kijk even naar die pagina.", "Even lezen.", "Ik open die pagina even."),
        "propose": (
            "Ik bereid die wijziging voor.",
            "Ik zet dat even klaar.",
            "Dat bereid ik nu voor.",
        ),
        "other": ("Momentje.", "Eén seconde.", "Even kijken."),
        "still": ("Nog even zoeken.", "Bijna klaar.", "Nog heel even."),
    },
}

_turns = count()


def group(tool: str) -> str:
    """What kind of wait this tool is: search, read, propose or other."""
    if tool.startswith("search_") or tool == "run_query_ro":
        return "search"
    if tool.startswith(("read_", "list_")) or tool == "load_skill":
        return "read"
    if tool.startswith("propose_") or tool == "schedule":
        return "propose"
    return "other"


def filler(tool: str | None, language: str | None) -> str:
    """One phrase for `tool` ("still" for a long wait), in `language` or English."""
    code = (language or "en").split("-")[0].split("_")[0].lower()
    table = FILLERS.get(code, FILLERS["en"])
    kind = "still" if tool is None else group(tool)
    phrases = table.get(kind) or FILLERS["en"][kind]
    return phrases[next(_turns) % len(phrases)]
