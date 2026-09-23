# Roadmap

Milestones for the first product. Each has a definition of done that can be demonstrated,
and every milestone leaves `main` runnable. Dates are deliberately absent; the "Where we are"
list below is the status.

## Where we are

**Shipped**

- M0 scaffold: monorepo, daemon launch contract, Tauri shell, CI on three OSes with a
  PyInstaller sidecar smoke test.
- M1 vault and editor (part 1): fileops, indexer, pages API, versions, trash, the converter
  with fixtures, the editor with page links, toggles, tables, checklists, the sidebar tree,
  save with conflict banner.
- M2 models and chat: catalog, downloads, llama-server lifecycle, providers (llama.cpp,
  OpenAI-compatible, Anthropic, OpenRouter), keychain, tools, instruction cascade, streaming
  chat with persisted conversations, in-app engine installs (D39).
- M3 review queue: propose tools, proposals API, accept/reject/edit/batch/revert, in-page
  decorations, auto-apply opt-in.
- M4 (most of it): chunk index, hybrid search, retrieval pipeline with citations, chat v2,
  jobs, cron, live notes, agents and workflows as Markdown, Runs view.
- M5 (part): audio and document uploads, in-app recording, Whisper transcription, OCR, page
  views (board, table, list) with properties.
- M5b personal assistant and voice: assistant definition, memory pages, background loop,
  reflection, realtime voice with VAD, turn detection, barge-in, Chatterbox TTS.
- MCP server and stdio bridge for local clients (from M8).

**In progress / remaining in the milestones above**

- M1 part 2: file watcher merge with 3-way diff, callouts, `graite:` fences beyond views,
  restore-from-trash UI, versions UI, `NAVIGATION.md`, moving pages between parents,
  vault-wide link rewrite on rename, editable `rawMarkdown` block, inline `[[` autocomplete.
- M4: `summarize_page` → `NAVIGATION-DEEP.md`, `read_navigation`, the `Cmd+K` search UI.
- M5: video, streaming Range delivery, attachment sync metadata, agent-facing media skills.
- M5b: live-microphone pass on all three platforms; `whisper-server` as an installable engine.

**Not started**: M6 databases and dashboards, M7 packaging and release, M8–M10.

## M0 — Scaffold

Monorepo per `ARCHITECTURE.md` §2; daemon with `/api/v1/health`, the `--port 0 --token`
launch contract, `--serve`, `/events`; Tauri window that spawns the sidecar; all platform
access through `src/lib/platform/`; CI with lint, tests and a sidecar build on three OSes.

Done when: `just dev` opens the app with a green health check; CI is green on three OSes and
produces a sidecar that starts on each.

## M1 — Vault and editor

`fileops.py` (single writer, locks, hashes, atomic writes, versions, activities), watcher,
indexer, navigation, traversal guard; REST for tree, pages with `base_hash`, create, move
with wikilink rewrite, trash, restore, versions; `packages/md-convert` with golden fixtures
and an idempotence test; BlockNote schema with callouts, toggles, wikilinks, `pageLink`,
`rawMarkdown`; slash menu; two-stage Cmd+A; save/conflict protocol with 3-way merge.

Done when: an existing Obsidian vault opens; editing a page changes only the intended lines
as seen by `git diff`; a change made in another editor while the page is open merges or
shows the banner; trash/restore and rename-with-link-rewrite work; the fixture suite passes.

## M2 — Models and chat

Catalog with ids pinned after verifying each GGUF; downloader as a job; llama-server
lifecycle (resident chat, TTL aux, lock, swap mode); providers; keys in the keychain;
hardware detection and backend selection; first-run wizard; skills registry; agent loop;
instruction cascade; page chat with streaming and tool activity; Models settings.

Done when: on a fresh machine the wizard downloads models and chat answers questions about
the open page using the local model; `AGENTS.md` instructions visibly change behaviour;
pasting an Anthropic key switches the provider.

## M3 — Review queue

`propose_*` skills; proposals table and API; apply/rebase/conflict; policy with the opt-in
dialog; Review view, proposal cards, in-page decorations; `list_proposals` tool.

Done when: "Add a TL;DR at the top of this page" produces a diff; accept, reject and
edit-then-accept work; a manual edit after the proposal makes accept detect the conflict; a
log page with `autonomy: auto-apply` and `auto_apply_kinds: [append]` is appended without
review and the change is revertible.

## M4 — Daemon jobs, cron, semantic search

Job queue with claim, wake, backoff and reaper; cron anchored on success; live notes;
embedding worker; chunker; hybrid search with RRF; `search_vault`; `Cmd+K`; page summaries
into `NAVIGATION-DEEP.md`.

Done when: a 1,000-page vault indexes in the background without blocking the editor; search
returns relevant chunks in under 200 ms; a live note with a nightly cron produces a proposal
the next morning; a failed job retries with backoff and is visible in Jobs.

## M5 — Media

`vault://` protocol with `Range`; uploads; image, audio, video and PDF blocks; in-app
recorder; transcription and OCR jobs feeding the index; `read_attachment_text`; attachment
hashes and `change_seq` for sync.

Done when: recording a memo yields a transcript within a minute; a dropped PDF is viewable
in-page and its text is searchable; a photo of a whiteboard is OCR'd into a page.

## M5b — Personal assistant and voice

Spec: `docs/design/voice-and-assistant.md`; decisions D33–D57. Assistant definition and memory
pages; background loop and reflection with preemption; voice with Silero VAD, Smart Turn,
resident whisper.cpp, Chatterbox on GGML through `crispasr`; interruption by speaking.

Done when: naming the assistant creates its definition and memory; "remember X" lands in the
profile without review after the opt-in while a page with `autonomy: none` still refuses; a
scheduled pass writes a journal entry and yields to a conversation; a spoken question with a
thinking pause is answered aloud once, in the speaker's language.

## M6 — Databases and dashboards

Per-page SQLite (`_data/data.sqlite` + `schema.json`), `db_exec` in fileops, `run_query_ro`
and `propose_db`, CSV import, `graite:dbview` block with inline editing, `graite:dashboard`
sandboxed iframe with a `postMessage` bridge.

Done when: a tasks table is created from the slash menu and edited inline; the agent adds
rows through a proposal; a generated dashboard charts the table and updates when rows change.

## M7 — Packaging and release

Code signing and notarization, signed Windows installers, `tauri-plugin-updater`; Graite's
own signed engine builds (`graite-llama`) and a signed remote catalog; GPU variant download
on first run; crash and log bundle export; Settings → Updates with per-component channels
and rollback; onboarding polish; docs site. See *Releasing* in `docs/development.md` for the current state.

Done when: signed installers for macOS arm64, Windows x64 and Linux x64 install on clean
machines; updating from the previous release works; an engine update installs, passes its
smoke test and can be rolled back; a new user reaches a working chat over their own vault
without reading docs.

## Later milestones (designed in `docs/design/remote-api-mobile.md`)

- **M8 — API and MCP**: scoped API tokens, OpenAI-compatible `/v1/chat/completions`, jobs and
  cron over the API, webhooks, MCP page resources and remote clients, an MCP client.
- **M9 — Remote access and PWA**: remote toggle (off by default), device tokens, Tailscale
  first, a mobile web UI at `/m`.
- **M10 — Mobile app and sync**: sync endpoints driven by `change_seq`, conflicts as
  proposals, a Capacitor app behind the platform adapter.
- **Still later**: teams and roles; `browse` and `web_search` skills.

## Risks

| Risk | Mitigation |
|---|---|
| Markdown ↔ BlockNote fidelity | Own the converter, `rawMarkdown` escape hatch, real-vault fixture corpus, idempotence tests. |
| BlockNote API churn | Pin exactly; wrap all BlockNote calls in `apps/desktop/src/editor/`. |
| Tool-calling reliability of 4–8B models | Tolerant delta parsing, JSON repair, recovery of unparsed tool syntax (D47), short tool list. |
| VRAM contention between chat, vision, embedding | TTL + swap mode; embedding model on CPU when needed. |
| PyInstaller packaging on three OSes | Exercised in CI on every change; the daemon stays torch-free. |
| Watcher storms; partial writes of `data.sqlite` on synced folders | Coalesce events, hash-based reindex, `sync_safe` journal mode. |
| Obsidian details (attachment links, custom callouts, frontmatter key order) | Relative links, fixed key order with unknown keys preserved, fixtures from real vaults. |
| llama.cpp build matrix maintenance | Pin upstream tags, automate in `graite-llama` with smoke tests, keep the previous version for rollback. |
| Public exposure of a write-capable daemon once remote access exists | Off by default; Tailscale first; device tokens with scopes; rate limiting; remote actions audited. |
| GPL codecs inside the PyAV wheel in the packaged daemon | Replace PyAV with an LGPL-only decode path before 1.0 (`THIRD_PARTY_NOTICES.md`). |

## Open questions

- Should conversations be exportable to Markdown pages? Default: SQLite only in v1.
- Default context window on 16 GB machines (8k vs 16k).
- Whether `NAVIGATION.md` should be depth-limited for very large vaults or split per top-level folder.
