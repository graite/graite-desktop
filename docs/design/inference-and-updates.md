# Inference and updates

How models actually run, how Graite makes them fast on whatever compute is present, and
how llama.cpp, the catalog, models and the app get updated.

## 1. llama-server contract

llama.cpp is the C++ inference engine. `llama-server` is its HTTP server binary: it loads a
GGUF file and exposes an OpenAI-compatible API (`/v1/chat/completions`, `/v1/embeddings`,
`/health`, `/slots`, `/metrics`). The daemon never links llama.cpp. It spawns one
`llama-server` process per loaded model on a random loopback port and talks HTTP to it.

Flags per role (catalog entries may override `ctx`, `ngl`, `parallel`):

| Role | Flags |
|---|---|
| chat | `-m <gguf> --host 127.0.0.1 --port <p> --api-key <random> -ngl <n> --ctx-size <c> --flash-attn on --jinja --parallel 2 --cache-reuse 256 -ctk q8_0 -ctv q8_0` |
| vision / OCR | chat flags plus `--mmproj <proj.gguf>` |
| embedding | `-m <gguf> --embedding --pooling last --ubatch-size 2048 -ngl <n>` |

- `--jinja` applies the model's own chat template, which is what makes tool calling work
  on Qwen-class models.
- `--parallel 2` gives two slots: one for the interactive chat, one for background jobs.
- `-ctk/-ctv q8_0` quantizes the KV cache, roughly halving context memory at negligible
  quality cost. Disabled per catalog entry where a model is known to dislike it.
- Each process gets its own random `--api-key` so nothing else on the machine can use it.

**Prompt-prefix caching is the biggest latency win.** `--cache-reuse` lets the server reuse
the KV cache for any prefix it has already seen. The agent prompt is therefore assembled in
a stable order — identity, navigation, instructions cascade, current page, history — so
that everything before the newest message hits the cache on every turn. Anything that
changes per request (timestamps, random ids) goes at the end, never at the top.

Later speed options exposed through the catalog and Settings: speculative decoding
(`-md <draft.gguf>`), multi-GPU (`--tensor-split`), and larger `--parallel` for servers.

## 2. Binaries: Graite owns the build matrix

Upstream llama.cpp publishes daily `bNNNN` tags with prebuilt zips, but coverage has gaps
(no Linux CUDA, no Linux arm64 CUDA, which is what a DGX Spark / GB10 or a Jetson needs),
and upstream asset names change. Graite therefore maintains a separate repository,
**`graite-llama`**, that:

1. pins an upstream tag,
2. builds `llama-server` with CMake in GitHub Actions for a fixed matrix,
3. runs a smoke test per artifact: start the server with a ~10 MB test GGUF, one completion,
   one tool call, one embedding,
4. publishes a GitHub release with the zips and a **signed `manifest.json`** (minisign).

| Variant | Backend | Notes |
|---|---|---|
| `macos-arm64` | Metal | default build; one variant covers all Apple Silicon |
| `windows-x64-cuda12` | CUDA 12.x | ships the cudart DLLs alongside |
| `windows-x64-vulkan` | Vulkan | AMD, Intel Arc, NVIDIA without a recent driver |
| `windows-x64-cpu` | AVX2 | bundled with the app |
| `linux-x64-cuda12` | CUDA 12.x | |
| `linux-x64-vulkan` | Vulkan | |
| `linux-x64-cpu` | AVX2 | bundled with the app |
| `linux-arm64-cuda12` | CUDA 12.x | Grace / DGX Spark / Jetson |
| `linux-arm64-cpu` | NEON | bundled with the app on arm64 |

`manifest.json`:

```json
{
  "version": "b7321-graite.2",
  "upstream_tag": "b7321",
  "min_daemon_version": "0.3.0",
  "variants": [
    {
      "id": "linux-x64-cuda12",
      "url": "https://github.com/graite/graite-llama/releases/download/b7321-graite.2/llama-server-linux-x64-cuda12.zip",
      "sha256": "…", "size": 41234567,
      "requires": { "os": "linux", "arch": "x86_64", "min_driver": "550.54", "cuda": "12" }
    }
  ]
}
```

The app bundles only the CPU variant for its platform (as a Tauri resource). GPU variants
are downloaded on first run into `~/.graite/bin/llama/<variant>/<version>/`, and a
`current` pointer file per variant names the active version.

## 3. Going fast when compute is available

`apps/daemon/graite/models/hardware.py` runs at startup, on demand from Settings, and after
every llama update.

1. **Detect.** OS and arch; NVIDIA via `nvidia-smi --query-gpu=name,memory.total,driver_version`
   (count, VRAM, driver); AMD and Intel via `vulkaninfo --summary`; Apple via
   `sysctl hw.memsize` (unified memory); system RAM via `psutil`. Unified-memory machines
   (Apple Silicon, GB10) are treated as one shared budget.
2. **Pick the variant.** macOS → `metal`. Windows and Linux → `cuda12` if an NVIDIA GPU is
   present and the driver satisfies the manifest's `min_driver`, else `vulkan` if a Vulkan
   GPU is present, else `cpu`. The choice is verified by running `llama-server --list-devices`
   with the candidate binary; on failure the next candidate is tried. Settings → Models →
   Backend lets the user override.
3. **Offload.** Layer count and tensor sizes are read from GGUF metadata with the `gguf`
   Python package. `-ngl` is computed from free VRAM minus a headroom (default 1 GB) minus
   the estimated KV cache for the configured context. Full offload when it fits; partial
   offload with a visible warning ("12 of 36 layers on GPU") when it does not. The GPU
   budget shared by chat, vision and embedding processes is enforced by the models manager
   (swap mode rather than OOM).
4. **Benchmark.** On first run and after any backend or llama change: a short prompt
   processing and generation test with the chat model. Tokens per second are stored and
   shown on the Models page, and used to recommend a tier and a default context size.
5. **Fallbacks.** If a GPU variant crashes at load, the manager records it, falls back to
   the next variant for that session, and shows why. CPU always works.

## 4. Updates

Four components have independent versions and channels. One Updates page shows them all.

| Component | Lives in | Channel | Updated by |
|---|---|---|---|
| App bundle (Tauri shell, daemon, bundled CPU llama, whisper runtime, built-in skills) | app install dir | `tauri-plugin-updater`, signed manifest | user click; notify by default |
| `llama-server` variants | `~/.graite/bin/llama/<variant>/<version>/` | `graite-llama` signed manifest | user click, or automatic if enabled |
| Model catalog | `~/.graite/catalog.json` | signed JSON published with Graite releases | automatic; only adds entries, never deletes files |
| Models | `~/.graite/models/` | catalog entries carrying `supersedes` | user click ("new version available") |

**Checking.** The daemon checks once a day and on launch: one request each for the app
manifest, the llama manifest and the catalog. It compares to what is installed and emits
`updates_available` on `/events` with the list. No telemetry is sent; the requests carry
no identifiers beyond the user agent.

**UI.** A badge on the sidebar when anything is available. Settings → Updates shows one
card per component: installed version, available version, changelog link, **Update**
button, plus **Update all**. Model cards on the Models page show "new version available"
and "needs llama.cpp ≥ bNNNN — update?" when a catalog entry's `min_llama_version` is
above the installed build. New model architectures are the usual reason to update
llama.cpp, so this is the path most users will take.

**Installing a llama variant.**
1. Download to a new `<version>` directory; verify sha256 against the signed manifest.
2. Run the bundled smoke test against the new binary (same test as CI).
3. Switch the `current` pointer atomically. Keep the previous version for one-click rollback
   (the Updates page lists it).
4. Reload running models: immediately if idle, otherwise a "reload now or later?" prompt.
   Background jobs wait for the reload.

**Compatibility gates.** The llama manifest carries `min_daemon_version`; the daemon carries
`llama_min_version`; catalog entries carry `min_llama_version`. An update is only offered
when all gates pass, and the reason is shown otherwise.

**Settings.** `updates.mode` per component: `notify` (default), `auto`, `off`. App updates
never auto-install. Everything is signed (Tauri's updater key for the app; minisign for the
llama manifest and the catalog) and every download is sha256-checked before use.

**Offline machines.** All three manifests can be imported from a file (Settings → Updates →
Import), and llama variants and models can be side-loaded into their directories; the
daemon verifies checksums against the imported manifest.

## Engine catalog v1 (D39)

What is implemented today, ahead of the `graite-llama` build repository described above.

`apps/daemon/graite/models/engines.json` ships with the app and pins, per engine, the version
this Graite release was tested with and one build per OS, architecture and backend: upstream
release archives with their sha256 (`llama` = llama.cpp `llama-server`, `crispasr` = the voice
engine). `models/engines.py`:

- **Recommend**: Metal on macOS, else Vulkan when a graphics card was detected, else the
  processor build. CUDA builds are listed but only installed when chosen under Advanced.
- **Install / update**: resumable verified download (`models/fetch.py`, shared with models) →
  safe unpack (no absolute paths, no `..`, links only inside the folder) into
  `<app_dir>/bin/<engine>/<variant>/.<version>.installing` → the executable must run
  (`--version`) → rename to `<version>/`, write `current`, remember `previous`, keep two
  versions. macOS: quarantine attribute cleared, ad-hoc signature added when unsigned.
- **Built here**: `scripts/build-voice-engine.sh` compiles CrispASR at the pinned version with
  CUDA (if `nvcc`), else Vulkan, else the processor, into
  `<app_dir>/bin/crispasr/local/<version>/` and sets `variant=local`. A `local` build is
  preferred over catalog builds unless the user picked one, is shown as "Built on this
  computer for its graphics card", and is never offered an update. On an NVIDIA GB10 it took a
  Chatterbox sample from 27–30 s (upstream processor build) to 6.1 s cold, ≈1.8 s warm.
- **Resolve**: a path typed under Advanced → the installed `current` → `PATH`.
  `hardware.detect()`, `voice/engines/crispasr.py` and `voice/runtime.py` go through it;
  engines are started with their own folder on the library path.
- **Updates**: a newer pin than the installed version shows "Update". Notify only; refused
  while an answer or a voice session is running (`model_busy`). Roll back switches `current`
  back to `previous`.
- **API**: `GET /engines`, `POST /engines/{id}/install {variant?}`, `…/cancel`, `…/rollback`,
  `DELETE /engines/{id}`; progress as `engine_progress` on `/events`.

Still to come (M7): Graite's own signed builds and manifest as designed above (only the
catalog's URLs change), a signed remote catalog so engines can update without an app release,
bundling a processor build for offline first runs, and `whisper-server` as a third entry.

### To verify on real installs

- **Windows**: a build downloaded by the app carries no Mark-of-the-Web, so no SmartScreen
  prompt is expected when Graite starts it; the engines listen on 127.0.0.1 only, so no
  firewall prompt; watch Defender's reaction to unsigned executables; check the Visual C++
  runtime dependency on a clean machine; the console window of the child process must stay
  hidden.
- **macOS**: files written by the app are not quarantined (Graite clears the attribute
  anyway); Apple Silicon needs at least an ad-hoc signature (checked, added when missing);
  upstream's crispasr build appears to be Apple Silicon only, so Intel Macs get no voice
  engine yet; a notarized Graite with the hardened runtime must still be allowed to start the
  downloaded executable.
- **Linux**: upstream builds target recent glibc; the arm64 crispasr build is processor-only.
