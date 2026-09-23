# Third-party notices

Graite's own code is Apache-2.0 (see `LICENSE` and `NOTICE`). The packaged application also
contains, or downloads at the user's request, the components below. Where a full list is
long, the command that regenerates it is given; run it at release time.

## 1. Desktop shell (compiled into the `graite-desktop` binary)

| Component | License |
|---|---|
| Tauri 2 (`tauri`, `tauri-build`), `tauri-plugin-dialog` | MIT OR Apache-2.0 |
| `webkit2gtk` (Rust bindings, Linux only) | MIT |
| `serde`, `serde_json`, `rand`, `hex` | MIT OR Apache-2.0 |

Full crate list: `cargo install cargo-about && cargo about generate --manifest-path apps/desktop/src-tauri/Cargo.toml about.hbs`,
or `cargo license --manifest-path apps/desktop/src-tauri/Cargo.toml`.

## 2. Web UI (embedded in the shell)

| Component | License | Note |
|---|---|---|
| BlockNote (`@blocknote/core`, `@blocknote/react`, `@blocknote/shadcn`) 0.47.1 | MPL-2.0 | Used unmodified. Source: <https://github.com/TypeCellOS/BlockNote/tree/v0.47.1>. MPL §3.2 is satisfied by this notice; changes to BlockNote files themselves would have to be published. |
| ProseMirror, TipTap (via BlockNote) | MIT | |
| React 19, `react-dom` | MIT | |
| Radix UI, `class-variance-authority` (Apache-2.0), `tailwind-merge`, `clsx` | MIT / Apache-2.0 | |
| Tailwind CSS 4, shadcn, `tw-animate-css` | MIT | |
| `lucide-react`, `yaml` | ISC | |
| `diff` | BSD-3-Clause | |
| `emoji-picker-react`, `sonner`, `@tanstack/react-store` | MIT | |
| `react-markdown`, `remark-*`, `mdast-util-*`, `unified`, `remark-wiki-link` | MIT | |
| `@tauri-apps/api`, `@tauri-apps/plugin-dialog` | MIT OR Apache-2.0 | |

No font files are bundled. Full list: `pnpm licenses list --prod`.

## 3. Python daemon (`resources/daemon`, a PyInstaller onedir bundle)

| Component | License | Note |
|---|---|---|
| CPython 3.12 | PSF-2.0 | |
| PyInstaller bootloader | GPL-2.0 with the PyInstaller Bootloader Exception | The exception permits bundling programs under any license. |
| FastAPI, pydantic, pydantic-settings, mcp, keyring, watchfiles, croniter, python-frontmatter, PyYAML, gguf, onnxruntime, sqlite-vec | MIT (sqlite-vec: MIT OR Apache-2.0) | |
| Starlette, uvicorn, httpx, psutil | BSD-3-Clause | |
| numpy | BSD-3-Clause and others (see its bundled `licenses/`) | |
| pypdfium2 + PDFium | BSD-3-Clause / Apache-2.0; PDFium BSD-3-Clause | |
| Pillow | MIT-CMU | |
| **PyAV 18** | BSD-3-Clause | **Bundles an FFmpeg build that includes GPL components (libx264, libx265).** See below. |

Full list: `uv run --project apps/daemon pip-licenses` (install `pip-licenses` into the dev group first).

### PyAV and FFmpeg

The official PyAV wheels ship FFmpeg built with `--enable-gpl`, including `libx264` and
`libx265`. Graite uses PyAV only to decode audio uploads to mono PCM
(`apps/daemon/graite/media/decode.py`); it never encodes and never touches video. Until PyAV
is replaced with an LGPL-only decode path (tracked under *Releasing* in `docs/development.md`), the **packaged
binaries** must be treated as distributed under GPL-3.0-or-later terms as a whole, while the
**source code** in this repository remains Apache-2.0. Do not ship a 1.0 with this in place.

## 4. Linux AppImage only

`bundleMediaFramework` copies the following from the Ubuntu 22.04 build image into the
AppImage: WebKitGTK 4.1, GTK 3, GLib, GStreamer core, base and good plugins (LGPL-2.1-or-later)
and their codec libraries (libopus BSD-3, libvorbis/libogg BSD-3, libFLAC BSD-3, libmpg123 and
libmp3lame LGPL-2.1, libvpx BSD-3). The release workflow removes the `ugly` and `libav`
plugin sets before bundling and fails if any of them is present in the AppImage. The
corresponding sources are the Ubuntu 22.04 source packages.

## 5. Downloaded at the user's request (never distributed by Graite)

Engines, pinned by version and checksum in `apps/daemon/graite/models/engines.json`:

| Engine | Source | License |
|---|---|---|
| `llama-server` (llama.cpp) | <https://github.com/ggml-org/llama.cpp> | MIT |
| `crispasr` (CrispASR, GGML Chatterbox) | <https://github.com/CrispStrobe/CrispASR> | MIT |
| `whisper-server` (whisper.cpp), when configured | <https://github.com/ggml-org/whisper.cpp> | MIT |

Models, pinned by revision and checksum in `apps/daemon/graite/models/catalog.json`:

| Model | Repository | License |
|---|---|---|
| EmbeddingGemma 300M (embeddings) | `unsloth/embeddinggemma-300m-GGUF` | **Gemma Terms of Use** (not an OSI license; read them before commercial use) |
| Whisper large-v3-turbo (speech) | `ggerganov/whisper.cpp` | MIT |
| GLM-OCR (documents) | `ggml-org/GLM-OCR-GGUF` | See the model card |
| Silero VAD v5 (voice activity) | `onnx-community/silero-vad` | MIT |
| Smart Turn v3 (turn detection) | `pipecat-ai/smart-turn-v3` | BSD-2-Clause |
| Chatterbox Multilingual (voice) | `cstr/chatterbox-GGUF` | MIT (Resemble AI Chatterbox) |

The Settings → Models discovery list also names Gemma 4 and Qwen3.8 families; those models
carry their own terms on Hugging Face. "Google" and "Qwen" are used only to name the
families; no logos are shipped.
