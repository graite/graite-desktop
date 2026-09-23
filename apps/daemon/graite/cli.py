"""`graite-daemon` entry point.

Sidecar contract (ARCHITECTURE.md §3): bind 127.0.0.1, print `{"port": N}` as the first
stdout line **once the service has actually started**, require the bearer token on every
request, exit when the parent closes stdin unless `--serve` (headless) is given. A daemon
that cannot start prints no handshake and exits non-zero, so the shell can say so instead of
waiting for a port nobody serves. Everything is also logged to `<app_dir>/logs/daemon.log`,
because a desktop launcher throws stderr away.

`graite-daemon selftest` checks a build from the inside (graite/selftest.py).

`graite-daemon mcp` is a different program: the stdio bridge MCP clients launch to reach the
running daemon (graite/mcp/stdio.py). It is dispatched before anything heavy is imported.
"""

from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
from pathlib import Path

import uvicorn

from graite import __version__
from graite.config import Settings
from graite.mcp import runtime


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="graite-daemon")
    parser.add_argument("--vault", type=Path, help="Vault directory.")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None, help="0 = pick a free port.")
    parser.add_argument("--token", default=None, help="Bearer token required on every request.")
    parser.add_argument("--dev", action="store_true", help="Read vault/port/token from .env.")
    parser.add_argument("--serve", action="store_true", help="Headless: ignore stdin EOF.")
    parser.add_argument("--log-level", default="info")
    return parser.parse_args(argv)


def _build_settings(args: argparse.Namespace) -> Settings:
    overrides = {
        key: value
        for key, value in {
            "vault": args.vault,
            "host": args.host,
            "port": args.port,
            "token": args.token,
            "dev": args.dev or None,
            "serve": args.serve or None,
        }.items()
        if value is not None
    }
    if args.dev:
        return Settings(**overrides)  # remaining fields come from .env
    # Production: no .env, everything explicit.
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg]


def _watch_stdin(server: uvicorn.Server) -> None:
    """Stop the server when the parent process closes our stdin (sidecar died)."""
    try:
        while sys.stdin.readline():
            pass
    except Exception:  # noqa: BLE001 - any stdin failure means "parent gone"
        pass
    server.should_exit = True


def _announce(server: uvicorn.Server, settings: Settings, port: int) -> None:
    """Tell the shell (stdout) and MCP bridges (`daemon.json`) where the daemon is, but only
    after startup succeeded. Until then the socket is bound yet nothing answers on it."""
    while not server.started:
        if server.should_exit:
            return  # startup failed; the traceback is in the log
        time.sleep(0.02)
    # First stdout line is the machine-readable handshake for the Tauri shell.
    print(json.dumps({"port": port, "pid": os.getpid()}), flush=True)
    # Lets `graite-daemon mcp` find this daemon; the port and token change every launch.
    shown_host = "127.0.0.1" if settings.host in ("0.0.0.0", "::") else settings.host
    runtime.write(
        settings.app_dir,
        url=f"http://{shown_host}:{port}",
        token=settings.token,
        vault=settings.vault.resolve(),
        version=__version__,
    )


def _configure_logging(level: str, app_dir: Path) -> None:
    logging.basicConfig(level=level.upper(), stream=sys.stderr)
    try:
        folder = app_dir / "logs"
        folder.mkdir(parents=True, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            folder / "daemon.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8"
        )
    except OSError:
        return  # a read-only app dir must not keep the daemon from starting
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)


def main(argv: list[str] | None = None) -> None:
    arguments = sys.argv[1:] if argv is None else argv
    if arguments[:1] == ["mcp"]:
        from graite.mcp import stdio

        stdio.main(arguments[1:])
        return
    if arguments[:1] == ["selftest"]:
        from graite import selftest

        selftest.main()
        return
    # Imported late: the bridge above must start fast and keep stdout for the protocol.
    from graite.app import create_app

    args = _parse_args(arguments)
    settings = _build_settings(args)
    if settings.host != "127.0.0.1" and not settings.serve:
        print("refusing to bind off loopback without --serve", file=sys.stderr)
        sys.exit(2)
    settings.vault.mkdir(parents=True, exist_ok=True)

    _configure_logging(args.log_level, settings.app_dir)
    app = create_app(settings)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((settings.host, settings.port))
    port = sock.getsockname()[1]

    config = uvicorn.Config(app, log_level=args.log_level, log_config=None)
    server = uvicorn.Server(config)

    # Sidecar mode only: exit when the parent closes our stdin. `--dev` daemons are started
    # standalone (e.g. by `just dev`) with no parent pipe, and `--serve` is headless.
    if not settings.serve and not settings.dev and not sys.stdin.closed:
        threading.Thread(target=_watch_stdin, args=(server,), daemon=True).start()
    # The handshake, and the file `graite-daemon mcp` reads, follow a successful startup.
    threading.Thread(target=_announce, args=(server, settings, port), daemon=True).start()
    try:
        server.run(sockets=[sock])
    finally:
        runtime.clear(settings.app_dir)


if __name__ == "__main__":
    main()
