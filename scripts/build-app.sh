#!/usr/bin/env bash
# Build the Python sidecar and standalone Linux desktop packages.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
export PATH="$project_root/.venv/bin:$HOME/.cargo/bin:$PATH"
if ! command -v patchelf >/dev/null; then
  echo "Install build dependencies first: uv sync --project apps/daemon --group build" >&2
  exit 1
fi
if [[ ! -x .venv/bin/pyinstaller ]]; then
  echo "Install build dependencies first: uv sync --project apps/daemon --group build"
  exit 1
fi
(cd apps/daemon && ../../.venv/bin/pyinstaller graite-daemon.spec --noconfirm)
# A daemon that cannot start would leave the installed app on its loading page: stop here.
./scripts/smoke-sidecar.sh
./scripts/place-sidecar.sh
# Tauri caches every embedded asset by content hash and rewrites it only when the file is
# missing, never when it is short. An interrupted build leaves a zero-byte entry that each
# later build happily reuses, and the app then opens on `asset not found: index.html`.
truncated_assets() {
  find apps/desktop/src-tauri/target -type d -name tauri-codegen-assets \
    -exec find {} -type f -size 0 "$@" \; 2>/dev/null
}
if [[ -n "$(truncated_assets -print)" ]]; then
  truncated_assets -delete
  echo "Dropped truncated assets from tauri's cache; re-embedding the frontend."
  touch apps/desktop/src-tauri/src/lib.rs
fi
pnpm --filter desktop tauri build --bundles appimage,deb
if [[ -n "$(truncated_assets -print)" ]]; then
  echo "This build was interrupted and left truncated assets behind. Run it again." >&2
  exit 1
fi
