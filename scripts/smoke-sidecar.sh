#!/usr/bin/env bash
# Does the *packaged* daemon work? Run after PyInstaller, before it goes into an installer.
#
#   scripts/smoke-sidecar.sh [path/to/graite-daemon]
#
# 1. `selftest`: data files, numpy/onnxruntime and the voice stack load inside the bundle.
# 2. A real start on a throw-away vault and app directory (never the user's ~/.graite): the
#    handshake must arrive, and the API must answer. A daemon that printed a port and then
#    died used to pass the old check and hang the app on its loading page.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exe="${1:-$root/apps/daemon/dist/graite-daemon/graite-daemon}"
[ -f "$exe.exe" ] && exe="$exe.exe"
[ -x "$exe" ] || { echo "smoke: no packaged daemon at $exe (run pyinstaller first)" >&2; exit 1; }

work="$(mktemp -d)"
pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() {
  echo "smoke: FAILED - $1" >&2
  echo "----- daemon stderr -----" >&2
  tail -n 40 "$work/err.txt" >&2 2>/dev/null || true
  exit 1
}

echo "smoke: selftest"
"$exe" selftest 2> "$work/err.txt" || fail "selftest"

echo "smoke: starting the daemon"
mkdir -p "$work/vault" "$work/app"
# --serve: headless, so the daemon does not stop when stdin closes (portable: no fifo needed).
GRAITE_APP_DIR="$work/app" "$exe" --vault "$work/vault" --port 0 --token smoke --serve \
  < /dev/null > "$work/out.txt" 2> "$work/err.txt" &
pid=$!

port=""
for _ in $(seq 1 150); do
  kill -0 "$pid" 2>/dev/null || fail "the daemon exited before it was ready"
  port="$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$work/out.txt" | head -n 1)"
  [ -n "$port" ] && break
  sleep 0.2
done
[ -n "$port" ] || fail "no handshake within 30 s"

for path in health engines voice/status; do
  code="$(curl -s -o "$work/body.txt" -w '%{http_code}' -m 10 \
    -H 'Authorization: Bearer smoke' "http://127.0.0.1:$port/api/v1/$path" || true)"
  [ "$code" = "200" ] || fail "GET /api/v1/$path answered $code"
  echo "smoke: /api/v1/$path ok"
done
[ -f "$work/app/daemon.json" ] || fail "daemon.json was not written to the app directory"
echo "smoke: ok (port $port)"
