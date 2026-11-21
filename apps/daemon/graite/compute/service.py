"""Calls between two devices over the sync socket.

Messages, each one device-to-device frame (`SyncService.to_peer`):
  caller → server  {"t": "c_call", "id", "kind", "head", "data", "last"}   the request
  caller → server  {"t": "c_more", "id", "data", "last"}                   more of its body
  server → caller  {"t": "c_head", "id", "head"}                           the reply starts
  server → caller  {"t": "c_part", "id", "data"}                           a piece of it
  server → caller  {"t": "c_end", "id", "error"?}                          done, or why not
  caller → server  {"t": "c_stop", "id"}                                   never mind
`data` is base64; a body is cut into pieces of `PIECE` bytes.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

PIECE = 192 * 1024
INFO_TIMEOUT = 6.0
HEAD_TIMEOUT = 300.0  # a model may have to load first
MAX_REQUEST = 64 * 1024 * 1024
OFF = "That computer does not share its AI. Switch it on there under Settings → AI workstation."
GONE = "The other computer is not connected right now."

# What a serving computer does with a call: yields the reply's head, then its pieces.
Handler = Callable[[dict[str, Any], bytes], AsyncIterator[dict[str, Any] | bytes]]
Send = Callable[[str, dict[str, Any]], Awaitable[None]]


class CallFailed(ValueError):
    pass


class Reply:
    """The answer to one call: `head`, then the pieces as they arrive."""

    def __init__(self, service: Compute, peer: str, call_id: str) -> None:
        self._service, self._peer, self._id = service, peer, call_id
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.head: dict[str, Any] = {}
        self._done = False

    async def _next(self) -> dict[str, Any]:
        try:
            async with asyncio.timeout(HEAD_TIMEOUT):
                return await self._queue.get()
        except TimeoutError as exc:
            await self.close()
            raise CallFailed("The other computer took too long to answer.") from exc

    async def start(self) -> None:
        message = await self._next()
        if message.get("t") != "c_head":
            self._done = True
            raise CallFailed(str(message.get("error") or GONE))
        head = message.get("head")
        self.head = head if isinstance(head, dict) else {}

    async def pieces(self) -> AsyncIterator[bytes]:
        while not self._done:
            message = await self._next()
            if message.get("t") == "c_part":
                yield base64.b64decode(str(message.get("data") or ""))
                continue
            self._done = True
            if message.get("error"):
                raise CallFailed(str(message["error"]))

    async def read(self) -> bytes:
        return b"".join([piece async for piece in self.pieces()])

    async def close(self) -> None:
        """Stop listening; tells the other computer to stop working when it has not finished."""
        self._service._calls.pop(self._id, None)
        if not self._done:
            self._done = True
            with contextlib.suppress(Exception):
                await self._service._send(self._peer, {"t": "c_stop", "id": self._id})


class Compute:
    """Both ends of the calls: `call` on the computer that asks, `handlers` on the one that
    answers. Whether this computer answers is an app-wide switch, off by default."""

    def __init__(self, app_dir: Path, send: Send) -> None:
        self._file = app_dir / "compute.json"
        self._send = send
        self.handlers: dict[str, Handler] = {}
        self._calls: dict[str, Reply] = {}
        # What each other device said it offers, the last time it was asked (`offers`).
        self.known: dict[str, dict[str, Any]] = {}
        self._next = 0
        # Calls this computer is answering: (caller, id) → what was received and the task.
        self._bodies: dict[tuple[str, str], tuple[str, dict[str, Any], bytearray]] = {}
        self._running: dict[tuple[str, str], asyncio.Task[None]] = {}

    # ---------------------------------------------------------------- the switch

    @property
    def serving(self) -> bool:
        try:
            return bool(json.loads(self._file.read_text(encoding="utf-8")).get("serve"))
        except OSError, ValueError, AttributeError:
            return False

    def set_serving(self, on: bool) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        self._file.write_text(json.dumps({"serve": on}), encoding="utf-8")

    # ---------------------------------------------------------------- asking

    async def call(self, peer: str, kind: str, head: dict[str, Any], body: bytes = b"") -> Reply:
        """Send a request to another device. The reply's head has arrived when this returns."""
        self._next += 1
        call_id = str(self._next)
        reply = Reply(self, peer, call_id)
        self._calls[call_id] = reply
        first, rest = body[:PIECE], body[PIECE:]
        await self._send(
            peer,
            {
                "t": "c_call",
                "id": call_id,
                "kind": kind,
                "head": head,
                "data": base64.b64encode(first).decode(),
                "last": not rest,
            },
        )
        while rest:
            piece, rest = rest[:PIECE], rest[PIECE:]
            await self._send(
                peer,
                {
                    "t": "c_more",
                    "id": call_id,
                    "data": base64.b64encode(piece).decode(),
                    "last": not rest,
                },
            )
        try:
            await reply.start()
        except BaseException:
            await reply.close()
            raise
        return reply

    async def offers(self, peer: str) -> dict[str, Any] | None:
        """What another device shares; None when it shares nothing, runs an older Graite or
        is gone."""
        try:
            async with asyncio.timeout(INFO_TIMEOUT):
                info = await self.ask(peer, "info", {})
        except ValueError, TimeoutError:
            info = None
        if isinstance(info, dict):
            self.known[peer] = info
            return info
        self.known.pop(peer, None)
        return None

    async def ask(self, peer: str, kind: str, head: dict[str, Any], body: bytes = b"") -> Any:
        """A call whose whole reply is one JSON value."""
        reply = await self.call(peer, kind, head, body)
        try:
            return json.loads(await reply.read() or b"null")
        finally:
            await reply.close()

    def lost(self, peer: str | None) -> None:
        """A device (or the connection) went away: nothing more will come from it."""
        for reply in list(self._calls.values()):
            if peer is None or reply._peer == peer:
                reply._queue.put_nowait({"t": "c_end", "error": GONE})
        for key, task in list(self._running.items()):
            if peer is None or key[0] == peer:
                task.cancel()
        for key in [k for k in self._bodies if peer is None or k[0] == peer]:
            del self._bodies[key]

    # ---------------------------------------------------------------- answering

    async def on_message(self, sender: str, message: dict[str, Any]) -> None:
        kind, call_id = message.get("t"), str(message.get("id"))
        if kind in ("c_head", "c_part", "c_end"):
            reply = self._calls.get(call_id)
            if reply is not None and reply._peer == sender:
                reply._queue.put_nowait(message)
            return
        key = (sender, call_id)
        if kind == "c_stop":
            self._bodies.pop(key, None)
            task = self._running.get(key)
            if task is not None:
                task.cancel()
            return
        if kind == "c_call":
            head = message.get("head")
            self._bodies[key] = (
                str(message.get("kind")),
                head if isinstance(head, dict) else {},
                bytearray(),
            )
        elif kind != "c_more" or key not in self._bodies:
            return
        what, head, body = self._bodies[key]
        try:
            body += base64.b64decode(str(message.get("data") or ""))
        except ValueError:
            body.clear()
        if len(body) > MAX_REQUEST:
            del self._bodies[key]
            await self._send(sender, {"t": "c_end", "id": call_id, "error": "Too large."})
            return
        if message.get("last"):
            del self._bodies[key]
            self._running[key] = asyncio.create_task(
                self._answer(sender, call_id, what, head, bytes(body)), name=f"compute:{what}"
            )

    async def _answer(
        self, caller: str, call_id: str, kind: str, head: dict[str, Any], body: bytes
    ) -> None:
        error: str | None = None
        try:
            handler = self.handlers.get(kind)
            if handler is None or not self.serving:
                error = OFF if handler is not None else "That computer runs an older Graite."
                return
            started = False
            async for item in handler(head, body):
                if not started:
                    started = True
                    await self._send(caller, {"t": "c_head", "id": call_id, "head": item})
                    continue
                assert isinstance(item, bytes)
                for start in range(0, len(item), PIECE):
                    data = base64.b64encode(item[start : start + PIECE]).decode()
                    await self._send(caller, {"t": "c_part", "id": call_id, "data": data})
        except asyncio.CancelledError:
            raise  # the caller stopped listening, or went away
        except ValueError as exc:
            error = str(exc)
        except Exception:
            log.exception("a call from another device failed")
            error = "The other computer could not finish this."
        finally:
            self._running.pop((caller, call_id), None)
            with contextlib.suppress(Exception):
                end: dict[str, Any] = {"t": "c_end", "id": call_id}
                if error:
                    end["error"] = error
                await asyncio.shield(self._send(caller, end))
