#!/usr/bin/env bash
# Build the voice engine (CrispASR) for this computer's graphics card and install it where
# Graite looks first: <app dir>/bin/crispasr/local/<version>/.
#
# For developers and for platforms without a ready-made GPU build (Linux arm64 today). The
# version is the one pinned in apps/daemon/graite/models/engines.json, i.e. the one this
# Graite was tested with. Needs git, cmake, a C++ compiler, and the CUDA toolkit (nvcc) or the
# Vulkan SDK (glslc); without either it builds for the processor.
#
#   scripts/build-voice-engine.sh            # build + install
#   GRAITE_APP_DIR=/somewhere scripts/build-voice-engine.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
app_dir="${GRAITE_APP_DIR:-$HOME/.graite}"
read -r version repo < <(python3 - "$root/apps/daemon/graite/models/engines.json" <<'PY'
import json, sys
engine = next(e for e in json.load(open(sys.argv[1]))["engines"] if e["id"] == "crispasr")
print(engine["version"], engine["repo"])
PY
)
src="$app_dir/cache/engine-src/crispasr-$version"
dest="$app_dir/bin/crispasr/local/$version"
export PATH="/usr/local/cuda/bin:$PATH"

flags=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF)
if command -v nvcc >/dev/null; then
  backend="CUDA"; flags+=(-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=native)
elif command -v glslc >/dev/null; then
  backend="Vulkan"; flags+=(-DGGML_VULKAN=ON)
else
  backend="processor only"
fi
echo "Building the voice engine $version ($backend) from github.com/$repo"

if [ ! -d "$src/.git" ]; then
  mkdir -p "$(dirname "$src")"
  git clone --depth 1 --branch "$version" --recurse-submodules --shallow-submodules \
    "https://github.com/$repo.git" "$src"
fi
cmake -S "$src" -B "$src/build" "${flags[@]}" > "$src/cmake.log" 2>&1 \
  || { tail -n 30 "$src/cmake.log" >&2; exit 1; }
jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
cmake --build "$src/build" -j "$jobs" --target crispasr-cli > "$src/build.log" 2>&1 \
  || cmake --build "$src/build" -j "$jobs" > "$src/build.log" 2>&1 \
  || { tail -n 40 "$src/build.log" >&2; exit 1; }

binary="$src/build/bin/crispasr"
[ -x "$binary" ] || { echo "The build finished without a crispasr executable." >&2; exit 1; }
"$binary" --version >/dev/null 2>&1 || { echo "The built engine does not start." >&2; exit 1; }

mkdir -p "$dest"
cp "$binary" "$dest/crispasr"
printf '%s\n' "$version" > "$app_dir/bin/crispasr/local/current"
printf '%s\n' "local" > "$app_dir/bin/crispasr/variant"
echo "Installed: $dest/crispasr ($backend)"
echo "Graite uses it from the next voice sample or conversation on."
