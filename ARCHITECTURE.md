# Graite — Architecture

Companion to `VISION.md` (why) and `ROADMAP.md` (when). Specs: `docs/vault-format.md`,
`docs/design/editor-roundtrip.md`. Decisions with rationale: `docs/decisions.md`.

## 1. Overview

```
┌──────────────────────────────── Desktop app (Tauri 2) ────────────────────────────────┐
│  WebView: React 19 + BlockNote 0.47 + shadcn + Tailwind 4                              │
│    editor/  ai/ (Graite AI page)  chat/ (Ask AI panel)  review/  models/  pages/        │
│         │ fetch + SSE (bearer token)          │ WebSocket /events                       │
│  Rust shell: spawns sidecar, generates token, vault:// protocol (Range), menus, dialogs │
└─────────┼─────────────────────────────────────┼────────────────────────────────────────┘
          ▼                                     ▼
┌──────────────────── graite-daemon (Python 3.12, FastAPI, 127.0.0.1:<random>) ──────────┐
│ api/        vault/ (fileops · watcher · indexer · instructions · policy · navigation)   │
│ index/      SQLite + sqlite-vec + FTS5 (.graite/index.sqlite) · chunker · embedder      │
│ retrieval/  scope · strategy · search · context · answer · research · pipeline          │
│ agent/      loop            skills/  registry · tools · library                         │
│ review/     proposals · policy         jobs/  queue · worker · handlers · cron          │
│ models/     catalog · downloader · llama_server · manager · providers/                  │
│ media/      decode (audio · pdf · image) · ocr · speech                                 │
└───────┬──────────────────────┬──────────────────────────┬──────────────────────────────┘
        ▼                      ▼                          ▼
  llama-server (chat)    llama-server (embed / vision, TTL)     Vault on disk
  127.0.0.1:<p1>         127.0.0.1:<p2..>                       MyVault/**/page.md, .graite/
```

Three processes at rest: the Tauri app, the daemon, and one `llama-server` holding the chat
model. Aux models spawn on demand and exit after a TTL.

## 2. Monorepo

```
graite-desktop/
  package.json  pnpm-workspace.yaml     # pnpm 10 workspaces: apps/*, packages/*
  pyproject.toml                        # uv workspace root (members: apps/daemon)
  Justfile                              # just dev | test | lint | build
  apps/
    desktop/                            # Tauri 2 + React 19 + Vite 8 + Tailwind 4 + shadcn + BlockNote 0.47 (pinned)
      src-tauri/  src/main.rs           # sidecar spawn, token, vault:// protocol, menu, dialogs
                  tauri.conf.json       # bundle.externalBin: binaries/graite-daemon; resources: llama cpu build
      src/        app/ editor/ review/ chat/ search/ models/ jobs/ settings/ lib/
    daemon/                             # Python 3.12, FastAPI, uv, ruff, pytest, mypy (strict on vault/ review/)
      graite/     main.py config.py api/ vault/ index/ models/ skills/ agent/ review/ jobs/ media/
      tests/      fixtures/vaults/*
      graite-daemon.spec                # PyInstaller onedir
  packages/
    md-convert/                         # TS: unified pipeline, mdast <-> BlockNote, vitest golden tests
    api-types/                          # TS types generated from the daemon's OpenAPI (openapi-typescript), checked in
  docs/
```

Tooling: pnpm 10, Vite 8, vitest 3, ESLint 9, Prettier; uv, ruff (lint + format),
pytest + pytest-asyncio, mypy. `just dev` runs `uv run graite-daemon --dev --vault <path>` and
`pnpm --filter desktop tauri dev` together.

## 3. Daemon

**Launch.** `graite-daemon --vault <path> --port 0 --token <hex>`. Binds `127.0.0.1` only.
Prints `{"port": N}` as the first stdout line once startup has succeeded (never before: a
daemon that cannot start prints nothing and exits non-zero); the Rust shell reads it. Every request needs
`Authorization: Bearer <token>`. In `--dev` mode a fixed port and token from `.env` are used.
`--serve` runs headless (no window, for services and remote access). The daemon never
imports Tauri. All routes live under `/api/v1/` with OpenAPI generated; the OpenAI-compatible
shim at `/v1/chat/completions` arrives in M8 (`docs/design/remote-api-mobile.md`). The MCP endpoint
`POST /mcp` exists for clients on the same machine: the write-free registry behind the same
token, with `graite-daemon mcp` as the stdio bridge that finds the daemon through
`~/.graite/daemon.json` (D30, D31).

**Transport.** REST for CRUD. SSE (`text/event-stream` over a POST, read with the ported
`streamPost`) for chat. One WebSocket `/events` for everything asynchronous:
`file_changed`, `tree_changed`, `proposal`, `proposal_decided`, `job_update`,
`model_progress`, `model_status`, `index_progress`. A second WebSocket,
`/api/v1/voice/session`, carries a live voice conversation with the assistant: microphone
PCM up, events and synthesized PCM down (D37, `docs/design/voice-and-assistant.md`).

**Lifespan order** (`graite/main.py`; every service exposes `start()/stop()`):
db → models manager → fileops + watcher → indexer → embedding worker → job worker → cron →
live notes. Shutdown reverses with a 15 s total timeout.

**Modules.**

| Module | Responsibility |
|---|---|
| `vault/fileops.py` | The single writer. Per-path locks, base-hash check, version snapshot, atomic write, index update, activity row, event. |
| `vault/watcher.py` | `watchfiles` on the vault; coalesces bursts (git checkout, sync clients); drops self-writes; feeds the indexer. |
| `vault/indexer.py` | Incremental scan: mtime + size fast path, hash slow path, moves detected by page id; maintains `pages`, `chunks`, `links` and FTS inside the write; enqueues `embed` on `body_hash` change. Full rebuild on demand. |
| `vault/policy.py` | Effective AI settings for a page (`instructions`, `autonomy`, `cloud`, `skills`, `model`) with the source of each value. `autonomy: none` and `cloud: local-only` are locks a descendant cannot lift. |
| `index/chunker.py` | Heading-aware splitter: title + heading path per chunk, lists and tables kept whole, deterministic text hash. |
| `index/embedder.py` | Creates `chunk_vec` from the model's own dimension, embeds pending chunks in batches, yields to chat, rebuilds on model change. |
| `retrieval/` | `scope` (pages + permissions), `strategy`, `search` (FTS + vec, RRF), `context` (numbered sources), `answer` (prompt, citations, limits), `research` (bounded loop), `pipeline` (one turn, recorded as a run). |
| `vault/navigation.py` | Writes `NAVIGATION.md` (debounced 2 s) and `NAVIGATION-DEEP.md` (when summaries change). |
| `vault/instructions.py` | Resolves the `AGENTS.md` cascade and frontmatter policy for a path. |
| `vault/versions.py` | Snapshot/list/restore under `.graite/versions/<id>/`. |
| `index/db.py`, `schema.sql`, `migrations/` | stdlib `sqlite3`, WAL, `busy_timeout=5000`, one connection per worker thread via `asyncio.to_thread`, `sqlite_vec.load(conn)`. |
| `models/*` | See §5. |
| `skills/registry.py`, `skills/builtin/*` | See §6. |
| `agent/loop.py` | Bounded streaming tool loop (see §6). Prompt assembly lives in `retrieval/answer.py` (§7). |
| `review/proposals.py`, `review/policy.py` | See §8. |
| `jobs/queue.py`, `worker.py`, `cron.py`, `live_notes.py` | See §4. |
| `models/speech.py` | whisper.cpp through an owned `whisper-server` (`SpeechServer`): started per job, or kept resident for a voice session. |
| `assistant/` | The personal assistant: profile sections, memory pages, `build_turn`, loop and reflect tasks, the foreground gate (D35, D36). |
| `voice/` | Realtime voice: framing, Silero VAD and Smart Turn (onnxruntime, CPU), sentence chunker, `TTSEngine` and the crispasr (GGML Chatterbox) engine, session and runtime (D33, D34, D37). |
| `media/ocr.py` | `llama-server --mmproj` with the vision model; prompt "Transcribe all text in reading order"; per-page PDF rendering via `pypdfium2`. |
| `media/decode.py`, `media/ocr.py` | PyAV audio decoding, PDFium rendering and PDF text layers, GLM-OCR through `llama-server --mmproj`. Embedding lives in `index/embedder.py`. |

## 4. Index, jobs and cron (SQLite)

```sql
CREATE TABLE pages (
  id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, parent_id TEXT, title TEXT, icon TEXT,
  frontmatter_json TEXT, body_hash TEXT, file_hash TEXT, mtime REAL, size INTEGER,
  summary TEXT, summary_hash TEXT, created TEXT, updated TEXT, indexed_at TEXT);
CREATE INDEX ix_pages_path ON pages(path);           -- subtree = path LIKE 'a/b/%'
CREATE TABLE links (src_id TEXT, target TEXT, target_id TEXT, kind TEXT, -- wiki | embed | md
  PRIMARY KEY (src_id, target, kind));
-- Chunks key on page_path: an imported page has no id until it is first written.
CREATE TABLE chunks (id INTEGER PRIMARY KEY, page_path TEXT NOT NULL, page_id TEXT, ord INTEGER,
  title TEXT, heading TEXT, heading_path TEXT, kind TEXT, start_line INTEGER, end_line INTEGER,
  text TEXT, text_hash TEXT, body_hash TEXT, embedded_model TEXT, UNIQUE (page_path, ord));
CREATE VIRTUAL TABLE chunk_fts USING fts5(text, title, heading, content='chunks',
  content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
-- chunk_vec is created at runtime by index/embedder.py with the embedding model's own
-- dimension (768 for EmbeddingGemma) and rebuilt when that model changes.
CREATE TABLE proposals (
  id TEXT PRIMARY KEY, job_id TEXT, conversation_id TEXT, path TEXT NOT NULL, kind TEXT NOT NULL,
  base_hash TEXT, old_text TEXT, new_text TEXT, patch TEXT, summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|rejected|conflict|auto_applied|superseded
  policy TEXT, decided_by TEXT, reason TEXT, created_at TEXT, decided_at TEXT, applied_version TEXT);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT, page_id TEXT,
  priority INTEGER DEFAULT 5, status TEXT DEFAULT 'pending', run_at TEXT,
  attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, locked_by TEXT, locked_at TEXT,
  result_json TEXT, error TEXT, created_at TEXT, finished_at TEXT);
CREATE INDEX ix_jobs_ready ON jobs(priority, run_at) WHERE status = 'pending';
CREATE TABLE cron (id TEXT PRIMARY KEY, name TEXT, expr TEXT, job_kind TEXT, payload_json TEXT,
  page_id TEXT, enabled INTEGER DEFAULT 1, last_run_at TEXT, next_run_at TEXT,
  last_status TEXT, failures INTEGER DEFAULT 0);
CREATE TABLE activities (id INTEGER PRIMARY KEY, ts TEXT, actor TEXT, action TEXT, path TEXT,
  detail_json TEXT, version_path TEXT);
CREATE TABLE models (id TEXT PRIMARY KEY, role TEXT, repo TEXT, filename TEXT, sha256 TEXT,
  size INTEGER, status TEXT, local_path TEXT, downloaded_at TEXT);
CREATE TABLE conversations (id TEXT PRIMARY KEY, page_id TEXT, title TEXT, messages_json TEXT,
  scope_json TEXT, mode TEXT, created_at TEXT, updated_at TEXT,
  context_json TEXT);   -- page_id NULL = vault chat; context_json = the numbered source set
CREATE TABLE runs (id TEXT PRIMARY KEY, kind TEXT, trigger TEXT, conversation_id TEXT, job_id TEXT,
  parent_run_id TEXT, agent TEXT, workflow TEXT, page_path TEXT, scope_json TEXT, mode TEXT,
  provider TEXT, model TEXT, cloud INTEGER, status TEXT, input_json TEXT, state_json TEXT,
  output_json TEXT, error TEXT, started_at TEXT, finished_at TEXT);
CREATE TABLE run_steps (id INTEGER PRIMARY KEY, run_id TEXT, ord INTEGER, kind TEXT, name TEXT,
  input_json TEXT, output_json TEXT, status TEXT, attempt INTEGER, started_at TEXT, finished_at TEXT);
CREATE TABLE attachments (id TEXT PRIMARY KEY, conversation_id TEXT, name TEXT, kind TEXT,
  mime TEXT, size INTEGER, sha256 TEXT, rel_path TEXT, text TEXT, text_status TEXT,
  pages INTEGER, error TEXT, created_at TEXT);   -- bytes under .graite/chat/<conversation-id>/
CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, kind TEXT, aliases_json TEXT, summary TEXT,
  page_path TEXT, source TEXT, created_at TEXT, updated_at TEXT);   -- filled from M-entities on
CREATE TABLE entity_mentions (entity_id TEXT, page_path TEXT, chunk_id INTEGER, count INTEGER,
  PRIMARY KEY (entity_id, page_path, chunk_id));
```

`jobs.page_id` is carried into the agent loop for every job:
per-folder instructions only work if background jobs know where they run.

**Claim** (one daemon per vault, so `BEGIN IMMEDIATE` is sufficient):

```python
conn.execute("BEGIN IMMEDIATE")
row = conn.execute(
    "SELECT id FROM jobs WHERE status='pending' AND run_at<=? ORDER BY priority, run_at LIMIT 1",
    (now,),
).fetchone()
if row:
    conn.execute(
        "UPDATE jobs SET status='running', locked_by=?, locked_at=?, "
        "attempts=attempts+1 WHERE id=?",
        (worker_id, now, row[0]),
    )
conn.execute("COMMIT")
```

**Wake.** `queue.enqueue()` sets an `asyncio.Event`; the worker loop awaits it with a 10 s
timeout, then drains up to the semaphore (default 2: one model job + one embed/transcribe
job). **Retry.** Failure → `status='pending'`, `run_at = now + 2^attempts × 30 s`, until
`max_attempts`. **Reaper.** Every 60 s, `running` jobs with `locked_at` older than 15 min go
back to `pending`. **Cron.** `croniter`, 30 s poll; `next_run_at` is anchored on the last
*successful* run; each failure doubles the interval up to 24 h. **Live Notes.** A page with
`live:` frontmatter is a cron row whose job runs the agent with the objective against the
page; the result is a proposal (or auto-applied if policy allows). `last_run_at` is written
only on success.

Job kinds in v1: `embed`, `reindex`, `attachment_text`, `summarize_page`, `agent_run`,
`workflow_run`, `extract_entities`, `live_note`. The worker runs two lanes — `embed`
(embedding, reindex, attachment text) and `model` (everything needing the chat model) — so a
bulk index and a model job never block each other, and bulk embedding yields between batches
while a question is waiting.

## 5. Models

**Catalog** (`models/catalog.json`, checked in, versioned). Entry: `id, role, repo, filename,
sha256, size, ctx, min_ram_gb, tier, notes`. Tiers: `small` (8 GB), `default` (16–32 GB),
`large` (48 GB+). Roles: `chat`, `embedding`, `vision`, `speech`.

Concrete ids are pinned at M2 after verifying support in the llama.cpp release we bundle
(see `docs/decisions.md` D12). Candidates: latest Qwen3.x small dense chat GGUF at Q4_K_M
(4B small / 8B default / 30B-class large), `Qwen3-Embedding-0.6B` GGUF Q8_0 (1024-d,
multilingual), a Qwen VL 3–4B GGUF + mmproj for OCR, whisper.cpp `large-v3-turbo` Q8 for speech,
and for voice conversation Silero VAD, Smart Turn and Chatterbox Multilingual (roles `vad`,
`turn`, `tts`). Cloud: Anthropic (Messages API with tools) and any
OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio).

**Download** (`models/downloader.py`). `huggingface_hub.hf_hub_download` with resume,
progress to `/events` as `model_progress`, sha256 verified after download, stored in
`~/.graite/models/`. Runs as a `download_model` job so it survives UI navigation.

**First-run wizard.** Detect RAM/VRAM (`psutil`, `llama-server --list-devices`), recommend a
tier, download chat + embedding first (app is usable), vision + speech lazily on first use.

**Lifecycle** (`models/llama_server.py`, `models/manager.py`, `models/hardware.py`; full
detail in `docs/design/inference-and-updates.md`). One `llama-server` subprocess per loaded model
on `127.0.0.1:<random>` with its own random `--api-key`, flags from the catalog (`--jinja`,
`--flash-attn`, `--ctx-size`, quantized KV cache, `--cache-reuse`), health-polled. The
agent prompt keeps a stable prefix order so the KV cache is reused across turns — the
largest latency win for chat over a vault. Policy: chat model
**resident**; embedding and vision **on demand with TTL** (10 min / 5 min); one
`asyncio.Lock` serializes load/unload; a memory budget (`gpu_budget_gb`) triggers swap mode
(unload chat while an aux model runs, reload after) instead of an OOM.

`hardware.py` detects GPU, driver and memory (unified memory counts as one budget), picks
the backend variant (`metal` / `cuda12` / `vulkan` / `cpu`), verifies it with
`--list-devices`, computes `-ngl` from GGUF metadata and free VRAM, and benchmarks on first
run. Binaries come from the **`graite-llama`** build repository (Graite's own matrix built
from a pinned upstream tag, smoke-tested, signed manifest) because upstream prebuilts have
gaps such as Linux CUDA and Linux arm64. The CPU variant is bundled with the app; GPU
variants download on first run into `~/.graite/bin/llama/<variant>/<version>/` with a
`current` pointer per variant so updates are atomic and rollback is one click.

**Updates.** Four channels — app bundle (Tauri updater), llama variants (`graite-llama`
manifest), model catalog (signed JSON), models (catalog `supersedes`) — checked daily, shown
on one Updates page with per-component **Update** buttons, gated by `min_daemon_version`
and `min_llama_version`. User click by default; app updates never auto-install.

**Providers** (`models/providers/`).

```python
class Provider(Protocol):
    async def chat(
        self, messages, tools, *, stream=True, thinking=False, **params
    ) -> AsyncIterator[ChatDelta]: ...
    async def embed(self, texts: list[str]) -> list[list[float]]: ...
```

`LlamaServerProvider`, `OpenAICompatProvider`, `AnthropicProvider`. Keys are stored in the OS
keychain via `keyring`, never in the vault. Model resolution: page/folder `model:` →
vault config → app default; unavailable → default plus a `model_status` event.

## 6. Skills and the agent loop

Registry (`@skill` decorator, signature → JSON Schema, `SkillResult`,
exception-to-result boundary), plus parameter descriptions via
`Annotated[str, "..."]`. Skills appear twice to the model — as tool schemas and as a prose
index in the system prompt.

**Registered tool set (complete list for v1):**

| Read | Search | Propose | Meta |
|---|---|---|---|
| `read_page(path, section?)` | `search_vault(query, scope?, k)` | `propose_edit(path, old, new, summary)` | `load_skill(name)` |
| `read_navigation(deep)` | `find_page(title_or_alias)` | `propose_append(path, text, summary)` | `schedule(when, instructions)` |
| `read_attachment_text(path)` | `run_query_ro(page_path, sql)` | `propose_create(path, body, frontmatter?, summary)` | `list_proposals(status)` |
| `list_children(path)` | | `propose_delete(path, summary)` | |
| | | `propose_move(path, new_path, summary)` | |
| | | `propose_attach(path, tmp, filename, summary)` | |
| | | `propose_db(page_path, sql, summary)` | |

There is no `write_*` tool anywhere in the registry. `schedule` creates a job row (a job is
not a vault write). Later phases add read-only `browse`, `web_search`, `transcribe`, `ocr`.

**Loop** (`agent/loop.py`): stream deltas; accumulate tool
calls by index (arguments arrive as string fragments); forward content tokens only when no
tool call is pending; invoke tools via the registry; append `tool` messages; repeat up to
10 rounds; strip `<think>` (including an unclosed trailing one) before `done`. Tolerant JSON
parsing with a repair step for small models. SSE events: `status`, `tool_start`, `tool_end`,
`proposal`, `page_updated`, `done`, `meta`, `error`.

## 7. Instructions cascade and prompt assembly

`vault/policy.py` resolves the cascade for a page: vault config → each ancestor's `AGENTS.md`
(text and frontmatter) → each ancestor page's frontmatter → the page itself, recording which
file set each value. `retrieval/answer.py` assembles the prompt from it, in order:

1. **Core**: identity; the tool contract ("you cannot write; propose instead"); the citation
   and honesty rules (cite `[n]`, say when the sources do not establish an answer, never
   treat silence as proof).
2. **Cascade**: one `## Instructions from <source>` section per `AGENTS.md` and per page
   `instructions` value, root first. Later sections override earlier ones.
3. **Skills index**: name + description of every available skill (page `_skills/` ∪ ancestor
   `_skills/` ∪ `.graite/skills/`, filtered by the `skills:` allowlist). Bodies load through
   `load_skill`; a skill's `allowed-tools` narrows the tool set for that turn.
4. **Pages in scope**: path and title of every page the conversation may read.
5. **Sources**: the numbered passages retrieval selected, each with its page and heading path.
6. **Conversation history**, trimmed to the remaining byte budget, then the question.

`NAVIGATION.md` is not in the prompt: sources carry their own page paths, and an answer must
cite the page it used rather than a generated summary. Jobs use the same assembly with the
scope from the job row; cron and Live Note jobs add the objective as the user message.

## 8. Review queue

**Creating a proposal.** Each `propose_*` skill reads the current file, validates
(`propose_edit`: `old` must occur exactly once — the Claude Code Edit contract), computes a
unified diff with `difflib`, stores `base_hash`, `old_text`, `new_text`, `patch`, `summary`,
emits a `proposal` event, and returns "Proposal p_… created; awaiting review" so the model
can continue. Proposals are rows in `proposals`, not files.

**Applying** (`review/proposals.py`). On accept: re-read the file. If `hash == base_hash`,
apply the patch. Else try to rebase by locating `old_text` exactly once in the current
content; success → apply and mark `rebased`. Otherwise `status = 'conflict'` and the UI
shows a 3-way view. `create` on an existing path → conflict. Batch accept applies in
creation order and stops at the first conflict. Reject stores a reason, fed back to the
conversation as a tool result if it is still open. **Edit-then-accept**: the UI edits the
"new" side; the daemon recomputes the patch and applies as `accepted (edited)`. Every apply
goes through fileops (snapshot + activity + event). Undo = restore the snapshot (itself
snapshotted).

**Policy** (`review/policy.py`). Resolved from the cascade: page frontmatter → nearest
`AGENTS.md` → vault config. Default `propose`. `auto-apply` requires `auto_apply_kinds`
(e.g. `[append]` for a daily log, `[create]` for an inbox) and a one-time explicit opt-in
dialog per folder the first time it would fire. `delete` and `move` are never auto-applied.
Auto-applied proposals still exist as rows (`auto_applied`) with snapshots and appear in the
Review view under "Applied automatically" with one-click revert.

**UI** (`apps/desktop/src/review/`). A Review view grouped by conversation/job; a
`ProposalCard` built on
`react-diff-viewer-continued` (split view, word-level highlight), listed as toggles that open
to the full card; an Activity view listing versions per page with restore. On the open page
each proposal shows **where it applies** (D27): the blocks an edit would change carry a
marker and a compact suggestion card with a word-level diff sits under them, appends sit at
the end, and page-level changes (create, delete, move, text that is gone) sit under the
title. Markers and card slots are ProseMirror decorations (`editor/reviewDecorations.ts`),
never document content, so opening a page with proposals does not change or save it. The
page's top bar counts the open reviews and offers Accept all (`accept-batch`) and Discard
all (`reject-batch`).

## 9. Tauri shell

- **Sidecar.** PyInstaller onedir build of `apps/daemon` → `binaries/graite-daemon-<triple>`,
  declared in `bundle.externalBin`, spawned with `tauri-plugin-shell`. Rust generates the
  token, passes it as an argument, parses the port line from stdout, kills the process on
  window close and `RunEvent::Exit`.
- **Webview ↔ daemon.** Plain `fetch` to `http://127.0.0.1:<port>` with the bearer token
  (obtained via a `get_daemon_info` command). CSP `connect-src http://127.0.0.1:* ws://127.0.0.1:*`.
- **Platform adapter.** The React app touches the host only through `src/lib/platform/`
  (daemon URL and token, file dialogs, media URL construction, clipboard). `desktop` is the
  Tauri implementation; `web` (PWA served by the daemon, media at `/media/<path>`) and
  `mobile` (Capacitor, local store) come later without touching the UI.
- **`vault://` protocol.** Registered with `register_asynchronous_uri_scheme_protocol`. Maps
  `vault://<vault-id>/Projects/Atlas/_attachments/x.mp4` to the file, rejects `..` and paths
  outside the vault, honors `Range` (video/audio seeking, PDF.js). Read-only.
- **Uploads.** BlockNote `uploadFile` → `POST /media/upload?page=<path>` (multipart) → returns
  the `vault://` URL.
- **Native.** `tauri-plugin-dialog` for Open Vault: the shell remembers the current and
  recent vault folders in `vaults.json` (app-config dir), shows a picker when none is
  remembered, and switches vaults by restarting the sidecar (`open_vault`, event
  `vault-changed`); `GRAITE_VAULT` overrides for launchers. Menu (File: New page, Open
  vault, Reveal in file manager; Edit; View; Help) later. `tauri-plugin-updater` with signed
  releases at M7.
- **Headless later.** The daemon has no dependency on Tauri; a `graite-daemon --serve` mode
  plus a tunnel is the path to remote and always-on use.

## 10. Security boundaries (v1)

- Daemon on loopback only, per-launch random token, no CORS wildcard. Tokens live in one
  `tokens` table (`kind`: ui / api / device, `scopes`, hashed at rest, revocable); remote
  access is off by default and never plain HTTP off loopback or WireGuard.
- Every activity row carries a client identity (`ui`, `api:<name>`, `device:<name>`,
  `agent:<job-id>`).
- Update manifests and the model catalog are signed (Tauri updater key, minisign); every
  download is sha256-checked before use.
- Agents: no write tools; `read_*` limited to the vault; `run_query_ro` opens page databases
  read-only; `propose_*` cannot target paths outside the vault or under `.graite/`.
- `vault://` and `/media` reject traversal; dashboards run sandboxed with no network.
- Cloud keys in the OS keychain; catalog downloads sha256-verified; llama.cpp binaries pinned
  to a release tag and verified.

## 11. Remote, API and mobile

Designed in `docs/design/remote-api-mobile.md`. In short: the daemon is already the API, so M8
adds scoped tokens, an OpenAI-compatible chat endpoint, jobs and webhooks, and an MCP
server over the same write-free tool set. M9 adds a remote toggle, device tokens, Tailscale
first, and a PWA at `/m`. M10 adds daemon-hub sync (`change_seq`, content hashes,
conflicts as proposals) and a Capacitor app behind the `platform` adapter. The v1 hooks
(`--serve`, `/api/v1/`, the platform adapter, actor identity, `change_seq`, the tokens
table, attachment hashes) are listed there and in `ROADMAP.md`.
