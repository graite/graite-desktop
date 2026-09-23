# Graite — guide for contributors and AI coding agents

Graite is a local-first knowledge workspace: Notion-style editor over an Obsidian-compatible
markdown vault, with local models and agents that only ever *propose* changes.

## Read first

- `VISION.md` — why, the bet, the four principles.
- `ARCHITECTURE.md` — system design, modules, schema, tool set.
- `ROADMAP.md` — milestones, what is shipped, risks.
- `docs/vault-format.md` — on-disk contract. `docs/design/editor-roundtrip.md` — converter and
  save/conflict protocol.
- `docs/design/inference-and-updates.md` — llama-server contract, hardware detection, engine catalog,
  update channels. `docs/design/voice-and-assistant.md` — the personal assistant, its memory and loop,
  and the realtime voice pipeline. `docs/design/remote-api-mobile.md` — API and MCP, remote access,
  mobile and sync, and the v1 hooks they need.
- `docs/decisions.md` — decisions with rationale. Add a row when you make one.
- `docs/development.md` — environment, commands, packaging, env vars, releasing.
- `docs/design/ai-retrieval-and-chat.md` — indexing, retrieval, the chat API, per-page AI settings.

## Hard rules for code

1. **All vault writes go through `apps/daemon/graite/vault/fileops.py`.** No other module
   opens a vault file for writing. The webview and the Rust shell never write vault files.
2. **Agents have no write tools.** The registry contains `read_*`, `search_*`, `propose_*`,
   `load_skill`, `schedule`, `run_query_ro` only. Do not add a `write_*` or `update_*` tool.
3. **Markdown on disk stays Obsidian-compatible.** New block types must map to native
   markdown or a ```` ```graite:<kind> ```` YAML fence, and must round-trip through
   `packages/md-convert` with a golden fixture.
4. **No torch.** Model work goes through native GGML engines (`llama-server`, `whisper-server`,
   `crispasr` for the assistant's voice). The one exception is CPU-only `onnxruntime` for the two
   small voice models that only exist as ONNX (Silero VAD, Smart Turn); nothing else may use it,
   and no GPU ONNX runtime is added (D33).
5. **Never rewrite a file just by opening it.**
6. `.graite/` is derivable state; the app must work after deleting it.
7. **The daemon never imports Tauri**, and the React app touches the host only through
   `src/lib/platform/`. Headless (`--serve`), the PWA and the mobile app depend on this.
8. Routes live under `/api/v1/`; changing a response shape means regenerating
   `apps/daemon/openapi.json` and `packages/api-types` (`just api-types`) and noting it in
   `docs/decisions.md` if it breaks clients.

## Stack

Tauri 2 + React 19 + Vite 8 + Tailwind 4 + shadcn + BlockNote 0.47 (pinned) in
`apps/desktop`. Python 3.12 + FastAPI daemon in `apps/daemon` (uv, ruff, pytest, mypy).
SQLite + sqlite-vec + FTS5 index. `packages/md-convert` (TS, unified/remark, vitest).

## Conventions

- Python: async everywhere, type hints, `Annotated[...]` descriptions on skill parameters,
  services expose `start()/stop()`, module singletons via `get_x()/set_x()`.
- TypeScript: functional components, all BlockNote access wrapped in `src/editor/`, API
  types from `packages/api-types` (regenerate from the daemon's OpenAPI, commit the result).
- Tests: every fileops change has a pytest; every converter change has a fixture.
- Commit messages: imperative, scoped (`daemon:`, `desktop:`, `md-convert:`, `docs:`).
- Nothing personal goes into the repo: no absolute home paths, no real names in comments or
  fixtures, no recordings. `examples/vault` is synthetic.

## Running

```
just setup        # .env, uv sync, pnpm install
just dev          # daemon (--dev, fixed port/token from apps/daemon/.env) + tauri dev
just test         # pytest + vitest + cargo test
just lint         # ruff + mypy + prettier + eslint + tsc + rustfmt + clippy
just fmt          # format everything
just sidecar      # PyInstaller build, smoke test, place into src-tauri/resources/daemon
```
