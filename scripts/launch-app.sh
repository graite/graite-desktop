#!/usr/bin/env bash
# Launch the newest standalone build. No Python, Node, or development server is needed.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
app_image=""
for candidate in "$project_root"/apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage; do
  [[ -f "$candidate" ]] || continue
  if [[ -z "$app_image" || "$candidate" -nt "$app_image" ]]; then
    app_image="$candidate"
  fi
done
if [[ -z "$app_image" ]]; then
  echo "Build Graite first: $project_root/scripts/build-app.sh" >&2
  exit 1
fi
# Always start the bundled service, even from a terminal previously used for development.
unset GRAITE_DAEMON_URL GRAITE_DAEMON_TOKEN
if [[ ! -r /dev/fuse || ! -w /dev/fuse ]]; then
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
exec "$app_image" "$@"
