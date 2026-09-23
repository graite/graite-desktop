# Graite developer tasks. Install just: https://github.com/casey/just

default:
    @just --list

# One-time setup: dev .env, Python (incl. build tools) and Node dependencies
setup:
    [ -f apps/daemon/.env ] || cp apps/daemon/.env.example apps/daemon/.env
    uv sync --project apps/daemon --all-groups
    pnpm install

# Run the daemon (dev mode: fixed port + token from apps/daemon/.env) and the desktop app together
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -f apps/daemon/.env ] || { echo "apps/daemon/.env is missing: run 'just setup'" >&2; exit 1; }
    trap 'kill 0' EXIT
    (cd apps/daemon && uv run graite-daemon --dev) &
    set -a; source apps/daemon/.env; set +a
    export GRAITE_DAEMON_URL="http://127.0.0.1:${GRAITE_PORT}" GRAITE_DAEMON_TOKEN="${GRAITE_TOKEN}"
    pnpm --filter desktop tauri dev

# Daemon only (dev mode)
daemon:
    cd apps/daemon && uv run graite-daemon --dev

# The Rust shell embeds apps/desktop/dist at compile time; build it once when missing
_dist:
    [ -d apps/desktop/dist ] || pnpm --filter desktop build

test: _dist
    cd apps/daemon && uv run pytest -q
    pnpm -r test
    cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml

lint: _dist
    uv run --project apps/daemon ruff check .
    uv run --project apps/daemon ruff format --check .
    cd apps/daemon && uv run mypy graite
    pnpm exec prettier --check "apps/desktop/src/**/*.{ts,tsx,css}" "packages/*/src/**/*.ts"
    pnpm -r lint
    pnpm -r typecheck
    cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
    cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings

fmt:
    uv run --project apps/daemon ruff format .
    uv run --project apps/daemon ruff check --fix .
    pnpm exec prettier --write "apps/desktop/src/**/*.{ts,tsx,css}" "packages/*/src/**/*.ts"
    cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml

# Build the daemon sidecar with PyInstaller and place it in apps/desktop/src-tauri/resources/daemon/
sidecar:
    cd apps/daemon && uv run --group build pyinstaller graite-daemon.spec --noconfirm
    ./scripts/smoke-sidecar.sh
    ./scripts/place-sidecar.sh

# Regenerate the OpenAPI document and the TypeScript API types after a route change
api-types:
    cd apps/daemon && uv run python -m graite.openapi > openapi.json
    pnpm --filter @graite/api-types generate
