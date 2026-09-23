# Retrieval, the Graite AI page, and per-page AI settings

The foundation every AI surface shares: one search index, one scope resolver, one answer
pipeline. Page chat, folder chat, the vault-wide **Graite AI** page and (later) scheduled
agents all call the same code with a different scope.

## Using it

- **Graite AI** sits at the top of the sidebar, above the page tree. It is a full page, not a
  panel, and it starts with every page in scope. The button in its header ("All pages" or
  "12 of 140 pages") opens a tree with tri-state checkboxes to narrow that.
- **Ask AI** on an open page opens the chat panel beside the editor. Its scope toggle picks
  "This page" or "& subpages".
- Both composers grow to eight lines and then scroll, take attachments (PDF, image, Markdown,
  text) by button or drag-and-drop, and offer **Ask** (read-only), **Draft** (may propose a
  new page) and **Act** (may propose edits, appends, new pages, deletions and moves). A
  proposal shows as a card with its diff under the answer that made it, in the **Review**
  section of the Studio, and as a banner on the page it targets; accept, edit-then-accept,
  reject with a reason (the model reads it next turn) or, once applied, revert.
- Selecting text in the editor adds a "Use selection" chip to the panel's composer; the
  selected passage then becomes source [1] for that question.
- A conversation shows its **context** once, at the top: every source it has gathered so far,
  numbered once and never renumbered. An answer lists only the sources that are new to that
  set, followed by a short **limits** note. Clicking a citation highlights the source;
  clicking a source opens the page. The model's thinking sits above the answer, collapsed.
- **Stop** cancels the run on the daemon and keeps the partial answer, marked as stopped.
  (Edit-and-resend is no longer in the UI; `replace_from` remains for API clients.)
- **AI settings** on a page (the sparkle next to the title, or the page menu) sets the page's
  instructions and permissions. Inherited values are shown with the page or file they come
  from.

## How an answer is produced

1. **Scope and permissions.** `retrieval/scope.py` turns the conversation's scope into a page
   list, then applies the policy cascade. A page whose effective `cloud` is `local-only` is
   dropped when the selected provider is a cloud one, and the answer says how many were.
2. **Follow-up or new topic.** `retrieval/followup.py` decides whether the question builds on
   what the conversation already gathered (`retrieval/contextset.py`): no earlier answer, a
   quoted phrase, identifier or date that occurs nowhere in the set, or too few of the
   question's content words covered means a new search. Otherwise the turn skips retrieval,
   answers from the set (the model may still call `search_vault`), and the limits line says
   "Answered from the N passages gathered earlier". The decision is a `followup` run step.
3. **Strategy.** `retrieval/strategy.py` reads the question: quoted phrases, identifiers and
   dates favour exact search; "list/all/every/with status" adds a structured pass over page
   properties and tags; comparisons and multi-part questions allow a longer research loop.
4. **Retrieve.** `retrieval/search.py` runs FTS5 (bm25, porter stemming) and, when an
   embedding model is installed, a sqlite-vec KNN over the same scope, then fuses them with
   reciprocal rank fusion. Titles and pages linked from the top hits get a small boost.
   Without vectors it degrades to keyword search and says so.
5. **Assemble.** `retrieval/context.py` expands each hit to its whole section (chunks sharing
   the heading path), adds a neighbour for very short chunks, dedupes, caps any one page at
   40% of the budget. New sources join the conversation's context set, which assigns the
   numbers; passages whose page changed are re-read first. Attachments and an attached
   selection are sources too. The set is capped at 60; sources that no longer fit the prompt
   stay in it so earlier citations still resolve.
6. **Generate.** `retrieval/answer.py` builds a byte-budgeted prompt: rules, the instruction
   cascade, the skills index, the pages in scope, the numbered sources in the order they were
   added, then history (long turns are clipped, never dropped). The prefix is constant for a
   conversation and sources only append, so llama-server reuses its KV cache
   (`cache_prompt`). One call answers most questions. When evidence is weak or the question is multi-hop, the same
   call may use `search_vault` and `read_page` for a few bounded rounds; each tool result
   becomes a new numbered source.
7. **Cite and bound.** Citations outside the source list are stripped. The limits note says
   what was searched, what was excluded and why, whether the semantic index is still
   building, and — when distinctive words of the question appear nowhere in scope — names
   them: *No page in scope mentions "Berlin" or "lease". That is silence in your notes, not
   evidence that it did not happen.*

Every turn is recorded in `runs` with one `run_steps` row per stage, so an answer can be
traced back to the passages and the model that produced it.

## Indexing

`index/chunker.py` splits a page around its headings. Each chunk keeps the page title and its
heading path, lists and tables stay whole unless they are oversized (then they split at item
or row boundaries with overlap), tiny sections merge with a sibling, and `graite:view` fences
are skipped because they are configuration. The chunk text hash is deterministic, so an edit
only re-embeds the sections that actually changed.

`vault/indexer.py` scans incrementally: unchanged mtime and size are skipped, an unchanged
file hash only refreshes stat columns, and a page that moved is re-pathed by id without
re-chunking. Chunking, links and FTS run inside the write, so keyword search is never stale.
Only embedding is deferred, as an `embed` job.

`vault/watcher.py` (watchfiles) notices edits made in Obsidian, vim or a sync client,
coalesces bursts, ignores `.graite/` and the daemon's own writes, and re-indexes just the
pages that changed. It stops by letting its stop event end the stream and closing it, because
cancelling mid-poll leaves the library's native thread to be torn down at interpreter exit,
which segfaults.

`jobs/` is a SQLite queue with two lanes: `embed` (embedding, reindex, attachment text) and
`model` (everything that needs the chat model). Jobs coalesce by key, retry with backoff, and
a reaper reclaims jobs left running by a crash. `index/embedder.py` keeps the embedding
server loaded across a batch and yields between batches whenever a question is waiting, so
chat never queues behind a bulk index.

The vector table is created from the embedding model's own dimension (768 for the
recommended EmbeddingGemma, not the 1024 the architecture sketch assumed) and is rebuilt when
the model changes.

## Agents, workflows and schedules

An **agent** is `<folder>/_agents/<name>.md`: frontmatter `scope` (defaults to the folder it
sits in), `mode` (`ask` or `act`), optional `model`, `skills`, `tools` and cron `schedule`;
the body is the instruction the run starts from. **Run now** in the Studio queues an
`agent_run` job; the job opens a run, calls the same pipeline as a chat turn with the propose
tools enabled, and files proposals for Review. A **workflow** is `_workflows/<name>.md` with
ordered `steps` (`agent`, optional `instructions` and `scope`); a `workflow_run` job opens a
parent run and one child run per step, each step seeing the previous answer as a source. The
**Schedules** view lists the cron rows synced from those files and from pages with a
`live.cron`, plus rows made by the `schedule` tool ("in 2 hours", "0 9 * * 1") or by hand.
**Runs** lists everything that ran, with steps, proposals and the job queue.

## Per-page settings

Reserved frontmatter keys, resolved by `vault/policy.py` from vault config → each ancestor's
`AGENTS.md` → each ancestor page → the page itself:

| Key | Meaning |
|---|---|
| `instructions` | How this page and its subtree should be structured. Accumulates root to leaf. |
| `autonomy` | `auto-apply`, `propose` (default) or `none`. `none` is a lock a nested page cannot lift. |
| `auto_apply_kinds` | Which proposal kinds (`append`, `create`, `edit`, `properties`) apply without review once the folder is confirmed. |
| `cloud` | `allowed` or `local-only`. `local-only` is a lock; such pages are left out of cloud answers. |
| `skills`, `model` | Skill allowlist and model override for the subtree. `model` is a catalog id or a saved model id (`m_…`, see AI & models). |

They are written only by `FileOps.set_ai_settings` through `PUT /api/v1/pages/{path}/ai-settings`,
which touches those keys and nothing else: the body and every other key stay byte-identical.

## API

| Route | Purpose |
|---|---|
| `GET /ai/conversations?page_path=` / `?scope=vault` | Page conversations, or the Graite AI page's |
| `POST /ai/conversations` | `{page_path}` or `{scope, mode}` |
| `PATCH` / `DELETE /ai/conversations/{id}` | Rename, rescope, delete (also deletes its attachments) |
| `POST /ai/conversations/{id}/messages` | SSE turn: `{message, mode, attachments, selection, replace_from}` |
| `GET /ai/conversations/{id}` | Messages plus `context`: the numbered source set without passage text |
| `POST /ai/conversations/{id}/cancel` | Stop the running turn |
| `POST/GET/DELETE /ai/conversations/{id}/attachments` | Chat uploads, stored under `.graite/chat/<id>/` |
| `GET /ai/index/status`, `POST /ai/index/rebuild` | Index state and a full rebuild |
| `GET /ai/jobs`, `DELETE /ai/jobs/{id}` | Background jobs |
| `GET/PUT /pages/{path}/ai-settings` | Own and effective AI settings, with the cascade `layers` |
| `GET /ai/proposals?status&conversation_id&page_path&run_id` | The review queue |
| `POST /ai/proposals/{id}/accept` `{new_text?}` | Apply (409 with the current body on a conflict) |
| `POST /ai/proposals/{id}/reject` `{reason}`, `/revert`, `/accept-batch`, `/opt-in` | Decide, undo, apply many, confirm auto-apply for a folder |
| `GET/POST /ai/agents`, `PUT/DELETE /ai/agents/{name}`, `POST /ai/agents/{name}/run` | Agent definitions (`_agents/<name>.md`) and manual runs |
| `GET/POST /ai/workflows`, `PUT/DELETE /ai/workflows/{name}`, `POST /ai/workflows/{name}/run` | Workflow definitions (`_workflows/<name>.md`) and manual runs |
| `GET/POST /ai/schedules`, `PATCH/DELETE /ai/schedules/{id}`, `POST /ai/schedules/{id}/run` | Cron rows: synced from definitions and live pages, or made by hand |
| `GET /ai/runs?kind&status&agent`, `GET /ai/runs/{id}` | The execution record: steps, proposals, child runs |
| `GET/POST /ai/connections`, `PATCH/DELETE /ai/connections/{id}` | App-wide connections (kind, endpoint, key in the keychain) |
| `POST /ai/connections/{id}/discover` | Models the endpoint offers (id, name, context length, pricing) |
| `POST /ai/connections/{id}/models`, `DELETE /ai/models/{id}` | Saved models that appear in every chat's model picker |

SSE event types: `run`, `meta`, `status`, `sources` (the whole set plus `new`, the numbers
added this turn), `token`, `thinking`, `reset`, `tool_start`, `tool_end`, `limits`,
`clarify`, `proposal` (a change the model just filed), `answer` (with `thinking`,
`new_sources` and `proposals`), `error`, `done`, plus `cancelled` when a turn is stopped.
WebSocket `/events` adds `proposal` and `proposal_decided`. Assistant messages persist `thinking`, `sources` (new ones only) and
`context: true`; messages saved before the context set existed carry `context: false` and
their own full source list. WebSocket `/events` adds `index_progress`, `job_update`, `attachment_update` and
`policy_changed`.

## Guards worth knowing about

- A chunk's vector is only written if the row still holds the text that was embedded
  (`text_hash` check). SQLite reuses freed rowids, so a page re-chunked while the model ran
  could otherwise be labelled with another section's vector. Vectors orphaned by a delete are
  swept on the next batch.
- Two page folders copied outside Graite share a frontmatter id; move detection claims each
  old path at most once instead of failing the scan.
- Citations are parsed outside code spans and fences, so `rows[0]` in an answer stays intact.
- The source list shown with an answer is trimmed to the passages that actually fit the
  prompt, so it never claims evidence the model did not see.
- Opening another chat while an answer streams stops that answer instead of letting it write
  into the chat now on screen; Enter during a stream keeps the draft rather than clearing it.
- A query embedding never evicts the resident chat model: when memory is tight the search
  degrades to keywords and the limits line says so. Cloud providers never wait for the local
  model lock. The scope is resolved once per conversation and vault change, and only
  `cloud: local-only` roots are read for the cloud gate.
- A turn that reaches its round budget answers from what it gathered, with tools withdrawn on
  the final round, instead of failing.

## Build

Everything CI runs passes locally on Linux: ruff, ruff format, mypy (`graite` is now clean;
it had eight pre-existing annotation errors before this work), pytest, the PyInstaller
onedir sidecar, eslint, tsc, vitest, the desktop bundle and `cargo check` on the Tauri shell.
The packaged sidecar was smoke-tested beyond the CI handshake: it opens a vault, builds the
index, and its bundled `watchfiles` extension picks up an external edit. macOS and Windows
are still only covered by CI.

## Limits

- Agents still have no write tools: every change is a proposal row applied by fileops.
  `auto-apply` needs a one-time confirmation per setting source and never covers delete or
  move.
- Cloud providers are gated per page by `cloud`, but the daemon cannot verify what a provider
  does with text it receives.
- Structured search covers page properties and tags only; page databases arrive with M6.
- The research loop is bounded (4–5 rounds, 12 tool calls) and deliberately does not run for
  simple questions.
- Model state (`installed`) is recorded per vault, so a vault that has never seen a model
  shows it as available until it is selected again.
