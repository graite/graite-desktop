"""How fast is Find on a thousand pages? `just bench-search` (D101).

    uv run python bench/search.py [--pages 1000] [--label run]

Builds the synthetic vault, indexes and embeds it with the embedding model on this computer,
then times `GET /api/v1/search` for a fixed set of queries: by words only, and with vectors
once the embedding model is loaded. The target is under 200 ms for the hybrid search.
Writes `docs/bench/<label>-search.md`. Exits 1 when the target is missed.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import tempfile
import time
from pathlib import Path

from ask import ROOT, TOKEN, wait_for_index
from fastapi.testclient import TestClient
from gen_vault import generate
from questions import GENERATED

from graite.app import create_app
from graite.config import Settings

TARGET_MS = 200.0
# What people type: a few words, names, half-typed words, and whole questions.
QUERIES = [
    "brightwater contract",
    "invoice 2026-0317",
    "halden freight overdue",
    "pricing review team plan",
    "lantern migration",
    "odile marchetti",
    "tide tables",
    "quarry dashboard pilot",
    "shared inbox response time",
    "onboarding",
    "permis",
    "export spreadsheet friday",
    "who signs large orders",
    "almere shipment damaged",
    "sync",
    *[q.text for q in GENERATED],
]


def measure(client: TestClient, repeats: int) -> tuple[list[float], list[float], int]:
    """Wall time of the request and the time the daemon reports, per query, in ms."""
    wall: list[float] = []
    inside: list[float] = []
    semantic = 0
    for _ in range(repeats):
        for query in QUERIES:
            started = time.perf_counter()
            result = client.get("/api/v1/search", params={"q": query, "k": 10}).json()
            wall.append((time.perf_counter() - started) * 1000)
            inside.append(result["took_ms"])
            semantic += bool(result["semantic"])
    return wall, inside, semantic


def line(name: str, wall: list[float], inside: list[float], semantic: int) -> str:
    ordered = sorted(wall)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    return (
        f"| {name} | {len(wall)} | {statistics.median(wall):.1f} | {p95:.1f} | {max(wall):.1f} "
        f"| {statistics.median(inside):.1f} | {semantic}/{len(wall)} |"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--pages", type=int, default=1000)
    parser.add_argument("--label", default="run")
    parser.add_argument("--embedding", default="embeddinggemma-300m-q8")
    parser.add_argument("--binary", default="", help="Path to llama-server.")
    parser.add_argument("--models-dir", type=Path, default=Path.home() / ".graite/models")
    parser.add_argument("--out", type=Path, default=ROOT / "docs" / "bench")
    parser.add_argument("--index-timeout", type=float, default=1800)
    args = parser.parse_args()
    binaries = sorted((Path.home() / ".graite/bin/llama").glob("*/*/llama-server"))
    binary = args.binary or (str(binaries[-1]) if binaries else "")

    with tempfile.TemporaryDirectory(prefix="graite-bench-") as work:
        vault = Path(work) / "vault"
        generate(vault, args.pages)
        settings = Settings(  # type: ignore[call-arg]
            _env_file=None,
            vault=vault,
            token=TOKEN,
            no_watch=True,
            app_dir=Path(work) / "app",
            models_dir=args.models_dir,
        )
        headers = {"Authorization": f"Bearer {TOKEN}"}
        with TestClient(create_app(settings), headers=headers) as client:
            downloads = client.app.state.downloads  # type: ignore[attr-defined]
            item = downloads.items.get(args.embedding)
            have_model = bool(item is not None and downloads.target(item).is_file() and binary)
            keyword = measure(client, repeats=3)
            hybrid = None
            if have_model:
                item.status, item.local_path = "installed", str(downloads.target(item))
                config = client.get("/api/v1/ai/status").json()["config"]
                client.put(
                    "/api/v1/ai/config",
                    json={**config, "binary_path": binary, "embedding_model_id": args.embedding},
                )
                print("embedding the vault…", file=sys.stderr)
                started = time.monotonic()
                index = wait_for_index(client, args.index_timeout)
                embed_s = time.monotonic() - started
                # What opening the palette does: load the model, then search as you type.
                client.post("/api/v1/search/warm")
                embedder = client.app.state.embedder  # type: ignore[attr-defined]
                for _ in range(120):
                    if embedder.ready_for_queries():
                        break
                    time.sleep(0.5)
                first = measure(client, repeats=1)  # every query new: embedded on the spot
                again = measure(client, repeats=3)  # typed before: the vector is cached
                hybrid = (first, again, index, embed_s)
            pages = client.get("/api/v1/ai/index/status").json()["pages"]

    rows = [line("Words and titles only (no model loaded)", *keyword)]
    worst = sorted(keyword[0])[int(len(keyword[0]) * 0.95)]
    notes = []
    if hybrid:
        first, again, index, embed_s = hybrid
        rows.append(line("Hybrid, query not seen before", *first))
        rows.append(line("Hybrid, query seen before (cached vector)", *again))
        worst = max(worst, sorted(again[0])[int(len(again[0]) * 0.95)])
        notes.append(
            f"Embedding {index.get('chunks')} passages took {embed_s:.0f} s "
            f"with `{args.embedding}` on CPU."
        )
        notes.append(
            "A query that was not seen before waits at most 120 ms for its vector; when the "
            "vector is later than that, the results are by words and titles and the vector "
            "is ready for the next keystroke."
        )
    else:
        notes.append("No embedding model or llama-server found: only the keyword path was timed.")
    report = "\n".join(
        [
            f"# bench-search: {args.label}",
            "",
            f"{pages} pages · {len(QUERIES)} queries · {time.strftime('%Y-%m-%d')} · "
            f"target: under {TARGET_MS:.0f} ms",
            "",
            "| Search | Requests | Median ms | p95 ms | Slowest ms | Median in daemon ms "
            "| Used vectors |",
            "|---|---:|---:|---:|---:|---:|---:|",
            *rows,
            "",
            *notes,
            "",
            f"Result: p95 {worst:.1f} ms, "
            + ("within the target." if worst < TARGET_MS else "**over the target.**"),
            "",
        ]
    )
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.label}-search.md").write_text(report)
    print(report)
    return 0 if worst < TARGET_MS else 1


if __name__ == "__main__":
    raise SystemExit(main())
