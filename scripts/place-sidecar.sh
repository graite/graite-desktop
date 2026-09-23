#!/usr/bin/env bash
# Copy the PyInstaller onedir build of the daemon into the Tauri resources folder.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/apps/daemon/dist/graite-daemon"
dst="$root/apps/desktop/src-tauri/resources/daemon"
[ -d "$src" ] || { echo "no build at $src (run: cd apps/daemon && uv run --group build pyinstaller graite-daemon.spec)"; exit 1; }
rm -rf "$dst"
mkdir -p "$dst"
cp -R "$src"/. "$dst"/
touch "$dst/.gitkeep"  # the folder is tracked so a fresh clone can run cargo check
echo "sidecar placed at $dst"
