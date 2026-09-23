#!/usr/bin/env bash
# Build-machine smoke check: exercise the AppImage's plugins without opening a microphone.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
export APPDIR="${1:-$project_root/apps/desktop/src-tauri/target/release/bundle/appimage/Graite.AppDir}"
if [[ ! -f "$APPDIR/apprun-hooks/linuxdeploy-plugin-gstreamer.sh" ]]; then
  echo "Missing AppImage GStreamer hook. Build with bundleMediaFramework enabled." >&2
  exit 1
fi
check_dir="$(mktemp -d /tmp/graite-media-plugins.XXXXXX)"
trap 'rm -rf "$check_dir"' EXIT
# Match the AppImage environment and use a fresh registry, never the system plugin cache.
source "$APPDIR/apprun-hooks/linuxdeploy-plugin-gstreamer.sh"
export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GST_REGISTRY_1_0="$check_dir/registry.bin"
for component in appsink appsrc pulsesrc audioconvert audioresample opusenc webmmux; do
  gst-inspect-1.0 "$component" > "$check_dir/inspect.txt" 2> "$check_dir/errors.txt" || {
    cat "$check_dir/errors.txt" >&2
    echo "Missing or unloadable bundled GStreamer component: $component" >&2
    exit 1
  }
  if ! grep -qF "$APPDIR/usr/lib/gstreamer-1.0/" "$check_dir/inspect.txt"; then
    echo "Component loaded outside the AppImage: $component" >&2
    exit 1
  fi
  echo "Bundled component OK: $component"
done
# Synthetic input verifies the capture sink and recording encoder without accessing a device.
timeout 20 gst-launch-1.0 -q audiotestsrc num-buffers=8 ! audioconvert ! audioresample ! appsink sync=false wait-on-eos=false
timeout 20 gst-launch-1.0 -q audiotestsrc num-buffers=8 ! audioconvert ! audioresample ! opusenc ! webmmux ! filesink location="$check_dir/recording.webm"
test -s "$check_dir/recording.webm"
echo "Bundled capture sink and WebM recording pipeline passed. No microphone was opened."
