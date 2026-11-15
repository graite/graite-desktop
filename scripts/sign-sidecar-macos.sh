#!/usr/bin/env bash
# Sign every Mach-O file of the placed sidecar with the Developer ID identity, so that
# notarization accepts the .app (it rejects any unsigned code inside the bundle).
#
#   APPLE_SIGNING_IDENTITY="Developer ID Application: ..." scripts/sign-sidecar-macos.sh [dir]
#
# Run after scripts/place-sidecar.sh and before `tauri build`. Without an identity (forks,
# local builds) it does nothing, and the bundle stays unsigned as before.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:-$root/apps/desktop/src-tauri/resources/daemon}"
entitlements="$root/packaging/macos/daemon.entitlements"
identity="${APPLE_SIGNING_IDENTITY:-}"

[ "$(uname -s)" = Darwin ] || { echo "sign-sidecar: not macOS, nothing to sign"; exit 0; }
[ -n "$identity" ] || { echo "sign-sidecar: APPLE_SIGNING_IDENTITY is not set; the daemon stays unsigned"; exit 0; }
[ -x "$dir/graite-daemon" ] || { echo "sign-sidecar: no daemon at $dir (run scripts/place-sidecar.sh)" >&2; exit 1; }

# Mach-O by content, not extension (the executable has none, some libraries have odd ones).
# Deepest paths first: nested code must be signed before whatever contains it.
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
find "$dir" -type f -print0 | while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then
    depth="$(printf '%s' "$file" | tr -cd '/' | wc -c | tr -d ' ')"
    printf '%s\t%s\n' "$depth" "$file"
  fi
done | sort -t $'\t' -k1,1nr -k2,2 | cut -f2- > "$list"

count="$(wc -l < "$list" | tr -d ' ')"
[ "$count" -gt 0 ] || { echo "sign-sidecar: no Mach-O files found in $dir" >&2; exit 1; }

# A secure timestamp needs a real identity; `-` (ad-hoc, for a local dry run) has none.
timestamp=--timestamp
[ "$identity" = "-" ] && timestamp=--timestamp=none
while IFS= read -r file; do
  codesign --force "$timestamp" --options runtime \
    --entitlements "$entitlements" --sign "$identity" "$file"
done < "$list"

codesign --verify --strict --verbose=2 "$dir/graite-daemon"
echo "sign-sidecar: signed $count Mach-O files in $dir"
