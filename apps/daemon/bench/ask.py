"""Ask the fixed questions and record what each turn cost: `just bench-ask` (D100).

    uv run python bench/ask.py --vault example  --label baseline
    uv run python bench/ask.py --vault generated --label baseline

Runs the daemon in this process on a copy of the vault (never the vault itself, never
`~/.graite`), with a local chat model and the embedding model, waits until the index is
built, then sends every question as a new conversation through the same route the app uses.
Writes `docs/bench/<label>-<vault>.json` and a Markdown table next to it.

It needs a chat model and llama-server on this computer. By default it looks in
`~/.graite/models` and `~/.graite/bin`; pass `--model` and `--binary` to point elsewhere.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from gen_vault import generate
from questions import EXAMPLE, GENERATED, Question

from graite.app import create_app
from graite.config import Settings

ROOT = Path(__file__).resolve().parents[3]
TOKEN = "bench-token"


def find(pattern: str, base: Path) -> str:
    found = sorted(base.glob(pattern))
    return str(found[-1]) if found else ""


def events_of(text: str) -> list[dict[str, Any]]:
    return [json.loads(part[6:]) for part in text.split("\n\n") if part.startswith("data: ")]


def wait_for_index(client: TestClient, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    status: dict[str, Any] = {}
    while time.monotonic() - started < timeout:
        status = client.get("/api/v1/ai/index/status").json()
        done = not status["pending_chunks"] or not status["embedding_model"]
        if status["chunks"] and done and status["worker"] != "running":
            return status
        time.sleep(1.0)
    print(f"index not finished after {timeout:.0f}s: {status}", file=sys.stderr)
    return status


def ask(client: TestClient, question: Question, extra: dict[str, Any]) -> dict[str, Any]:
    conversation = client.post("/api/v1/ai/conversations", json={"scope": {"kind": "vault"}}).json()
    started = time.monotonic()
    response = client.post(
        f"/api/v1/ai/conversations/{conversation['id']}/messages",
        json={"message": question.text, **extra},
    )
    wall = time.monotonic() - started
    events = events_of(response.text)
    answer = next((e for e in events if e["type"] == "answer"), None)
    error = next((e["text"] for e in events if e["type"] == "error"), None)
    metrics = next((e["metrics"] for e in events if e["type"] == "metrics"), {})
    shown = next((e["sources"] for e in reversed(events) if e["type"] == "sources"), [])
    cited = [s["page_path"] for s in (answer or {}).get("sources", [])]
    text = (answer or {}).get("text", "")
    return {
        "question": question.text,
        "page": question.page,
        "answer": text,
        "error": error or (None if answer else f"HTTP {response.status_code}"),
        "cited": cited,
        # The right page was given to the model / the answer cites it / the fact came out.
        "retrieved_right": question.page in {s["page_path"] for s in shown},
        "cited_right": question.page in cited,
        "answered": any(word.lower() in text.lower() for word in question.expect),
        "wall_s": round(wall, 2),
        "metrics": metrics,
    }


def mean(rows: list[dict[str, Any]], key: str) -> float:
    values = [r["metrics"].get(key) for r in rows if r["metrics"].get(key) is not None]
    return sum(values) / len(values) if values else 0.0


def table(label: str, vault: str, pages: int, model: str, rows: list[dict[str, Any]]) -> str:
    def cell(row: dict[str, Any], key: str, unit: str = "") -> str:
        value = row["metrics"].get(key)
        if value is None:
            return "–"
        return f"{value:,.0f}{unit}" if isinstance(value, (int, float)) else str(value)

    yes = {True: "yes", False: "no"}
    lines = [
        f"# bench-ask: {label}, {vault} vault",
        "",
        f"{pages} pages · model `{model}` · {len(rows)} questions · {time.strftime('%Y-%m-%d')}",
        "",
        "| # | Question | Retrieval ms | Pages | Passages | Context tokens | Prompt tokens "
        "| Prompt read ms | First token ms | Total ms | Tokens/s | Right page given "
        "| Right page cited | Answered |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|",
    ]
    for index, row in enumerate(rows, 1):
        lines.append(
            f"| {index} | {row['question']} | {cell(row, 'retrieval_ms')} | {cell(row, 'pages')} "
            f"| {cell(row, 'chunks')} | {cell(row, 'context_tokens')} "
            f"| {cell(row, 'prompt_tokens')} | {cell(row, 'prompt_ms')} "
            f"| {cell(row, 'first_token_ms')} "
            f"| {cell(row, 'total_ms')} | {cell(row, 'tokens_per_second')} "
            f"| {yes[row['retrieved_right']]} | {yes[row['cited_right']]} "
            f"| {yes[row['answered']]} |"
        )
    count = len(rows)
    lines += [
        f"| | **Mean** | {mean(rows, 'retrieval_ms'):,.0f} | {mean(rows, 'pages'):.1f} "
        f"| {mean(rows, 'chunks'):.1f} | {mean(rows, 'context_tokens'):,.0f} "
        f"| {mean(rows, 'prompt_tokens'):,.0f} | {mean(rows, 'prompt_ms'):,.0f} "
        f"| {mean(rows, 'first_token_ms'):,.0f} "
        f"| {mean(rows, 'total_ms'):,.0f} | {mean(rows, 'tokens_per_second'):.1f} "
        f"| {sum(r['retrieved_right'] for r in rows)}/{count} "
        f"| {sum(r['cited_right'] for r in rows)}/{count} "
        f"| {sum(r['answered'] for r in rows)}/{count} |",
        "",
        "Context tokens are estimated (four characters to a token); prompt tokens and "
        'tokens/s are what the model server reported. "Right page given" means the page '
        "that holds the answer was among the passages or tool results of the turn.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--vault", choices=["example", "generated"], default="example")
    parser.add_argument("--label", default="run")
    parser.add_argument("--pages", type=int, default=1000, help="Size of the generated vault.")
    parser.add_argument("--model", default="", help="Path to a chat GGUF.")
    parser.add_argument("--binary", default="", help="Path to llama-server.")
    parser.add_argument("--embedding", default="embeddinggemma-300m-q8")
    parser.add_argument("--context-size", type=int, default=8192)
    parser.add_argument("--models-dir", type=Path, default=Path.home() / ".graite/models")
    parser.add_argument("--out", type=Path, default=ROOT / "docs" / "bench")
    parser.add_argument("--index-timeout", type=float, default=1800)
    parser.add_argument("--limit", type=int, default=0, help="Ask only the first N questions.")
    parser.add_argument(
        "--send", default="{}", help='Extra JSON for each message, e.g. \'{"depth":"deep"}\'.'
    )
    args = parser.parse_args()

    model = (
        args.model
        or find("gemma4-e2b-q4/*.gguf", args.models_dir)
        or find("*/*.gguf", args.models_dir)
    )
    binary = args.binary or find("*/*/llama-server", Path.home() / ".graite/bin/llama")
    if not model or not Path(model).is_file():
        print("No chat model found. Download one in Graite or pass --model.", file=sys.stderr)
        return 2
    if not binary or not Path(binary).is_file():
        print(
            "No llama-server found. Install the engine in Graite or pass --binary.", file=sys.stderr
        )
        return 2

    questions = EXAMPLE if args.vault == "example" else GENERATED
    if args.limit:
        questions = questions[: args.limit]
    with tempfile.TemporaryDirectory(prefix="graite-bench-") as work:
        vault = Path(work) / "vault"
        if args.vault == "example":
            shutil.copytree(
                ROOT / "examples" / "vault", vault, ignore=shutil.ignore_patterns(".graite")
            )
        else:
            generate(vault, args.pages)
        settings = Settings(  # type: ignore[call-arg]
            _env_file=None,
            vault=vault,
            token=TOKEN,
            no_watch=True,
            app_dir=Path(work) / "app",
            models_dir=args.models_dir,
        )
        with TestClient(
            create_app(settings), headers={"Authorization": f"Bearer {TOKEN}"}
        ) as client:
            # Which models are downloaded is recorded per vault; this copy starts empty, so
            # tell it about the embedding model that is already on disk.
            downloads = client.app.state.downloads  # type: ignore[attr-defined]
            embedding = downloads.items.get(args.embedding)
            if embedding is not None and downloads.target(embedding).is_file():
                embedding.status = "installed"
                embedding.local_path = str(downloads.target(embedding))
            else:
                print(
                    f"embedding model {args.embedding} is not downloaded: keyword search only",
                    file=sys.stderr,
                )
            config = client.get("/api/v1/ai/status").json()["config"]
            saved = client.put(
                "/api/v1/ai/config",
                json={
                    **config,
                    "provider": "local",
                    "model_path": model,
                    "binary_path": binary,
                    "embedding_model_id": args.embedding,
                    "context_size": args.context_size,
                },
            )
            if saved.status_code != 200:
                print(f"could not configure the model: {saved.text}", file=sys.stderr)
                return 2
            print("building the index…", file=sys.stderr)
            index = wait_for_index(client, args.index_timeout)
            print(
                f"index: {index.get('pages')} pages, {index.get('chunks')} passages, "
                f"embedding model {index.get('vector_model')}",
                file=sys.stderr,
            )
            rows = []
            extra = json.loads(args.send)
            for number, question in enumerate(questions, 1):
                row = ask(client, question, extra)
                rows.append(row)
                m = row["metrics"]
                print(
                    f"{number:>2}. {m.get('context_tokens', '?')} ctx tokens, first token "
                    f"{m.get('first_token_ms', '?')} ms, {m.get('tokens_per_second', '?')} tok/s, "
                    f"cited right page: {row['cited_right']}, answered: {row['answered']}"
                    + (f"  ERROR {row['error']}" if row["error"] else ""),
                    file=sys.stderr,
                )
            pages = int(index.get("pages") or 0)
    args.out.mkdir(parents=True, exist_ok=True)
    name = f"{args.label}-{args.vault}"
    result = {
        "label": args.label,
        "vault": args.vault,
        "pages": pages,
        "model": Path(model).name,
        "context_size": args.context_size,
        "semantic": bool(index.get("vector_model")),
        "date": time.strftime("%Y-%m-%d"),
        "rows": rows,
    }
    (args.out / f"{name}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    report = table(args.label, args.vault, pages, Path(model).name, rows)
    (args.out / f"{name}.md").write_text(report)
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
