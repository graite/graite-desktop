# Developing Graite

## Prerequisites

- **Rust** stable via [rustup](https://rustup.rs), with `rustfmt` and `clippy`
  (`rustup component add rustfmt clippy`).
- **Node 24** and **pnpm 10** (`corepack enable` or <https://pnpm.io/installation>).
- **uv** (<https://docs.astral.sh/uv/>); it installs Python 3.12 for you.
- **just** (<https://github.com/casey/just>).
- The **Tauri 2 system dependencies** for your OS: <https://tauri.app/start/prerequisites/>.
  On Debian/Ubuntu also install `patchelf` (needed to bundle GStreamer into the AppImage).

## First run

```bash
just setup   # copies apps/daemon/.env.example to .env, uv sync (incl. build group), pnpm install
just dev     # daemon in --dev mode on examples/vault + `tauri dev` with hot reload
```

`just dev` starts two processes:

1. `graite-daemon --dev` in `apps/daemon`. In dev mode the daemon reads `apps/daemon/.env`
   (`GRAITE_VAULT`, `GRAITE_PORT`, `GRAITE_TOKEN`) instead of being spawned as a sidecar with a
   random port and token, and it does not exit when stdin closes.
2. `pnpm --filter desktop tauri dev` with `GRAITE_DAEMON_URL` and `GRAITE_DAEMON_TOKEN`
   exported. When both are set the Rust shell spawns no sidecar and connects to that daemon;
   the in-app vault switcher is disabled because the daemon owns the vault.

To point the dev daemon at another vault, edit `GRAITE_VAULT` in `apps/daemon/.env` (relative
paths resolve from `apps/daemon`). The example vault is described in `examples/README.md`.

## Everyday commands

```bash
just test        # pytest (apps/daemon), vitest (desktop + packages), cargo test (src-tauri)
just lint        # ruff, ruff format --check, mypy, prettier --check, eslint, tsc, rustfmt, clippy
just fmt         # ruff format + fix, prettier --write, cargo fmt
just daemon      # only the daemon, for curl / MCP experiments
just api-types   # regenerate apps/daemon/openapi.json and packages/api-types after a route change
just sidecar     # PyInstaller build + smoke test + place into apps/desktop/src-tauri/resources/daemon
```

Run a single suite directly when iterating:

```bash
cd apps/daemon && uv run pytest tests/test_fileops.py -q
pnpm --filter desktop test -- src/editor
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Layout

```
apps/desktop/src          React app. app/ editor/ review/ chat/ ai/ assistant/ models/ settings/ lib/
apps/desktop/src/lib/platform   the only place that talks to Tauri (enforced by eslint)
apps/desktop/src/editor   the only place that imports BlockNote (enforced by eslint)
apps/desktop/src-tauri    Rust shell: daemon.rs (sidecar), vaults.rs (recent vaults), lib.rs (commands)
apps/daemon/graite        Python daemon; see ARCHITECTURE.md §3 for the module table
apps/daemon/tests         pytest; fixtures use a tmp_path vault
packages/md-convert       Markdown <-> BlockNote; fixtures/ are golden round-trip cases
packages/api-types        TypeScript types generated from apps/daemon/openapi.json (committed)
scripts/                  build-app.sh, smoke-sidecar.sh, place-sidecar.sh, check-appimage-media.sh,
                          launch-app.sh, install-local-launcher.py, build-voice-engine.sh
```

## Environment variables

All daemon settings are `GRAITE_*` (`apps/daemon/graite/config.py`); CLI flags override them.

| Variable | Read by | Meaning |
|---|---|---|
| `GRAITE_VAULT` | daemon, shell, launcher | Vault root. For the shell it must be an existing absolute directory and it wins over the remembered vault. |
| `GRAITE_HOST` | daemon | Bind host, default `127.0.0.1`. Anything else is refused without `--serve`. |
| `GRAITE_PORT` | daemon, `just dev` | Port; `0` picks a free one and prints it on stdout. |
| `GRAITE_TOKEN` | daemon, `just dev` | Bearer token required on every request. |
| `GRAITE_APP_DIR` | daemon, scripts | App-wide state, default `~/.graite` (logs, `daemon.json`, `bin/`, `cache/`, connections). |
| `GRAITE_MODELS_DIR` | daemon | Model files, default `~/.graite/models`. |
| `GRAITE_FEEDBACK_URL` | daemon | Where `POST /api/v1/feedback` forwards to; empty (default) hides the form. |
| `GRAITE_DEV` / `GRAITE_SERVE` / `GRAITE_NO_WATCH` | daemon | Same as `--dev`, `--serve` (headless), and disabling the vault watcher. |
| `GRAITE_DAEMON_URL` + `GRAITE_DAEMON_TOKEN` | shell | Connect to an existing daemon instead of spawning the sidecar (dev). |
| `GRAITE_DEVTOOLS` | shell (debug builds) | Open the WebKit inspector on start. |

## Logs and state

The daemon logs to stderr and to `<GRAITE_APP_DIR>/logs/daemon.log` (rotated at 1 MB). If a
packaged app cannot start its service, the startup screen points there. `daemon.json` in the
same folder is how `graite-daemon mcp` (the MCP stdio bridge) finds the running daemon.

Per-vault derived state lives in `<vault>/.graite/` (index, versions, trash, chat
attachments). Deleting it is always safe.

## Building a packaged app locally (Linux)

```bash
uv sync --project apps/daemon --group build     # PyInstaller + patchelf (done by `just setup` too)
./scripts/build-app.sh                          # sidecar -> smoke test -> AppImage + deb
./scripts/check-appimage-media.sh               # GStreamer capture plugins load from the bundle
./scripts/launch-app.sh                         # newest AppImage; set GRAITE_VAULT to choose a vault
python3 scripts/install-local-launcher.py --vault /abs/path/to/vault   # app-menu entry
```

Bundles land in `apps/desktop/src-tauri/target/release/bundle/`. The same steps run in CI
(`.github/workflows/ci.yml` builds and smoke-tests the sidecar on every change;
`release.yml` builds full bundles on a tag; see *Releasing* below).

`scripts/smoke-sidecar.sh` runs `graite-daemon selftest` inside the bundle and then starts the
packaged daemon on a throw-away vault and app directory, requiring `/api/v1/health`,
`/engines` and `/voice/status` to answer. Data files are bundled by pattern
(`DATA_PATTERNS` in `apps/daemon/graite-daemon.spec`); `tests/test_packaging.py` fails when a
non-Python file under `graite/` is not covered.

### Linux: microphone capture in the AppImage

The Linux build machine needs `patchelf` on `PATH` for the GStreamer bundling plugin
(Ubuntu/Debian: `sudo apt install patchelf`). `scripts/build-app.sh` checks this before building.

AppImages enable Tauri's `bundleMediaFramework` option. WebKitGTK requires the GStreamer
capture plugins (including `appsink`) and the plugin scanner inside the bundle; Python's
PyAV libraries alone do not provide browser microphone capture. `getUserMedia` requests
`audio: true` so device defaults are used without optional echo/noise constraints.

After a Linux bundle build, run `scripts/check-appimage-media.sh`. It checks that capture,
conversion, and Opus/WebM plugins load from the bundle with a fresh registry, then runs
synthetic audio through the capture sink and recording encoder without opening a microphone.

If the webview has no working MediaRecorder encoder, Graite uses Web Audio to capture
16-bit mono PCM and saves a standard WAV attachment through the same upload flow.
This fallback uses the device's native sample rate, does not play back microphone input,
and closes its audio context on stop. It stops at 180 MB or just under one hour,
whichever comes first; WAV needs more disk space than compressed Opus recordings.

## Engines and models

Nothing model-related is in the repository. Engines (`llama-server`, `crispasr`) and models
are installed from Settings into `GRAITE_APP_DIR` from the pinned entries in
`apps/daemon/graite/models/engines.json` and `catalog.json`. `scripts/build-voice-engine.sh`
compiles CrispASR for the local graphics card when no suitable build is published. See
`docs/design/inference-and-updates.md`.

## MCP

With the app or `just daemon` running, an MCP client can launch `graite-daemon mcp` (from a
dev checkout: `uv run --project apps/daemon graite-daemon mcp`; from an AppImage:
`/path/to/Graite.AppImage mcp`). Settings → MCP shows the exact command.

## Releasing

### What exists today

`.github/workflows/release.yml` builds **unsigned** bundles on a `v*` tag: AppImage and deb
(Ubuntu 22.04), dmg (macOS, Apple silicon), NSIS installer (Windows). Each job builds the
PyInstaller sidecar first, smoke-tests it, places it in `src-tauri/resources/daemon`, then
runs `tauri-action`, which creates a **draft** GitHub release with the bundles attached. On
Linux the workflow also checks that the AppImage's GStreamer plugins load and that no GPL
plugin set was bundled, and smoke-tests the daemon inside the AppImage and the `.app`.

Run the workflow manually (`workflow_dispatch`) for a dry run: same builds, uploaded as
artifacts, no release.

### Cutting a release

1. Bump the version in all of: `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/src-tauri/Cargo.toml` (and `Cargo.lock` via `cargo update -p graite-desktop`),
   `apps/desktop/package.json`, `apps/daemon/pyproject.toml` (and `uv lock`),
   `apps/daemon/graite/__init__.py`, `packages/api-types/package.json`, `packages/md-convert/package.json`.
2. Commit, tag `vX.Y.Z` (the workflow refuses a tag that does not start with the `tauri.conf.json` version),
   push the tag.
3. Review the draft release, write the notes there, publish. Tags with a suffix
   (e.g. `v0.2.0-rc.1`) are marked as pre-releases; use them for test builds.

### Known limits of the preview builds

- **Unsigned.** macOS users must run `xattr -cr /Applications/Graite.app`; Windows shows the
  SmartScreen "unknown publisher" prompt.
- **No updater.** Users download the next version by hand.
- **Windows: NSIS only.** The MSI target is off because WiX has a 260-character limit on
  source paths and the PyInstaller onedir is deep; enable `msi` in the matrix only after a
  manual dry run has produced one.
- **Engines are not bundled.** A fresh install downloads `llama-server` and, for voice,
  `crispasr` from the pinned upstream releases on first use (D39).
- **GPL codecs inside the sidecar.** The PyAV wheel bundles FFmpeg with libx264/libx265; see
  `THIRD_PARTY_NOTICES.md`. The packaged binaries must be treated as GPL-distributed until PyAV
  is replaced. This is release-blocking for 1.0, not for previews.

### Follow-ups before 1.0 (ROADMAP M7)

- Code signing: Apple Developer ID + notarization (`APPLE_*` secrets for `tauri-action`),
  a Windows code-signing certificate, and Linux minisign for the updater manifest.
- `tauri-plugin-updater` with a signing key pair; `createUpdaterArtifacts`; the Updates page
  with per-component channels (app, engines, catalog, models) and rollback.
- `graite-llama`: Graite's own signed llama.cpp build matrix with smoke tests, replacing the
  upstream URLs in `engines.json`; a signed remote catalog.
- Replace PyAV with an LGPL-only audio decode path (`soundfile` + resampling in the daemon,
  `decodeAudioData` in the webview for webm/m4a) and remove `av` from the sidecar.
- Add a `license` field to `catalog.json` entries and show it on the model card.
- One source of truth for the version number.
