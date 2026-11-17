"""Write a synthetic vault for benchmarks: `python bench/gen_vault.py OUT [--pages 1000]`.

Deterministic for a given `--seed`: the same pages, text and ids every time, so results from
different days can be compared. Everything in it is invented. The `FACTS` of `questions.py`
are planted on their pages; the rest is filler in the same shape, on the same subjects, so
finding a fact means telling it from hundreds of similar passages.
"""

from __future__ import annotations

import argparse
import random
import shutil
import uuid
from pathlib import Path

from questions import FACTS

FIRST = "Ada Bram Carys Daan Elif Finn Greta Hugo Imre Jola Kees Lena Milo Nora Otis Pia".split()
LAST = "Aalto Berg Castell Dorn Eklund Faas Grijs Holm Ivers Jansen Kuyper Lund Maas".split()
PLACES = "Almere Breda Delft Ede Gouda Haarlem Leiden Meppel Nijmegen Oss Tiel Zwolle".split()
TRADES = (
    "bakery freight orchard clinic foundry brewery nursery printworks shipyard quarry "
    "creamery sawmill tannery ropeworks pottery"
).split()
NAMES = "Alder Birch Cinder Dune Ember Fallow Garnet Harrow Iris Juniper Kestrel Larch".split()
TOPICS = (
    "onboarding pricing reporting exports permissions notifications scheduling search "
    "mobile sync billing audit templates integrations"
).split()
VERBS = "reviewed agreed postponed estimated shipped measured raised closed reopened".split()

AREAS = {
    # area: (share of pages, headings)
    "Customers": (0.2, ["Snapshot", "People", "What they need", "Contract", "History"]),
    "Meetings": (0.3, ["Summary", "Decisions", "Action items", "Notes"]),
    "Projects": (0.15, ["Goal", "Timeline", "Risks", "Status"]),
    "Invoices": (0.15, ["Status", "Lines", "Notes"]),
    "Research": (0.1, ["In one paragraph", "Key claims", "Method"]),
    "People": (0.1, ["Role", "Works with", "Notes"]),
}


def sentence(rng: random.Random) -> str:
    who = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    forms = [
        "{who} {verb} the {topic} work for the {place} {trade} and expects an answer in {n} days.",
        "The {place} {trade} asked about {topic}; {who} {verb} it after {n} calls.",
        "For {topic}, the team {verb} {n} items with the {trade} in {place}.",
        "{who} noted that {topic} took {n} hours last month at the {place} site.",
        "The {trade} in {place} wants {topic} before the next review, said {who}.",
    ]
    return rng.choice(forms).format(
        who=who,
        verb=rng.choice(VERBS),
        topic=rng.choice(TOPICS),
        place=rng.choice(PLACES),
        trade=rng.choice(TRADES),
        n=rng.randint(2, 48),
    )


def title_for(area: str, index: int, rng: random.Random) -> str:
    if area == "Customers":
        return f"{rng.choice(NAMES)} {rng.choice(TRADES).title()} {index}"
    if area == "Meetings":
        month, day = rng.randint(1, 12), rng.randint(1, 28)
        return f"2026-{month:02d}-{day:02d} {rng.choice(TOPICS).title()} sync {index}"
    if area == "Projects":
        return f"{rng.choice(NAMES)} {rng.choice(TOPICS)} {index}"
    if area == "Invoices":
        return f"Invoice 2025-{index:04d}"
    if area == "Research":
        return f"{rng.choice(TOPICS).title()} study {index}"
    return f"{rng.choice(FIRST)} {rng.choice(LAST)} {index}"


def body(rng: random.Random, headings: list[str], planted: dict[str, str]) -> str:
    parts = []
    for heading in headings:
        lines = [sentence(rng) for _ in range(rng.randint(2, 5))]
        if heading in planted:
            lines.insert(rng.randint(0, len(lines)), planted[heading])
        if heading in ("Action items", "Lines", "Key claims", "People"):
            text = "\n".join(f"- {line}" for line in lines)
        else:
            text = " ".join(lines)
        parts.append(f"## {heading}\n\n{text}")
    return "\n\n".join(parts) + "\n"


def write_page(vault: Path, rel: str, text: str, rng: random.Random) -> None:
    folder = vault / rel
    folder.mkdir(parents=True, exist_ok=True)
    page_id = uuid.UUID(int=rng.getrandbits(128), version=4)
    title = rel.rsplit("/", 1)[-1]
    front = (
        f"---\nid: {page_id}\ntitle: {title}\n"
        "created: '2026-06-01T09:00:00Z'\nupdated: '2026-06-01T09:00:00Z'\n---\n\n"
    )
    (folder / "page.md").write_text(front + text, encoding="utf-8")


def generate(out: Path, pages: int = 1000, seed: int = 7) -> int:
    rng = random.Random(seed)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    planted: dict[str, dict[str, str]] = {}
    for fact in FACTS:
        planted.setdefault(fact.page, {})[fact.heading] = fact.sentence
    written = 0
    for area in AREAS:
        write_page(out, area, f"Everything about {area.lower()}.\n", rng)
        written += 1
    for page, facts in planted.items():
        area = page.split("/", 1)[0]
        write_page(out, page, body(rng, AREAS[area][1], facts), rng)
        written += 1
    remaining = pages - written
    for area, (share, headings) in AREAS.items():
        for index in range(1, round(remaining * share) + 1):
            if written >= pages:
                break
            rel = f"{area}/{title_for(area, index, rng)}"
            if (out / rel).exists():
                continue
            write_page(out, rel, body(rng, headings, {}), rng)
            written += 1
    return written


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("out", type=Path)
    parser.add_argument("--pages", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    count = generate(args.out, args.pages, args.seed)
    print(f"{count} pages written to {args.out}")
