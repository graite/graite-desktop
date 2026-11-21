"""This daemon's connection to the other devices of a synced space, through Graite Cloud.

One outbound WebSocket (`{cloud}/sync/v1/connect`), kept open while sync is on for this
vault. Graite Cloud passes frames between the devices of a space and reads none of them:
every payload is sealed with the space key (`crypto.seal`).

Sealed payloads (JSON):
  in an `op` frame, to every other device:
    {"entry": {...}, "content": base64 | null}      one version of one file
  Graite Cloud numbers each op, answers `sent` to its author, and keeps it for the devices
  that are off until they connect; a device answers `ack` with the number it has applied.
  in a `peer` frame, to one device:
    {"t": "manifest_req"}
    {"t": "manifest", "entries": [...]}              everything it holds, in parts
    {"t": "get", "id", "path", "hash"}               the bytes of a version
    {"t": "blob", "id", "data", "last"} | {"t": "blob", "id", "missing": true}

When two devices connect they compare a digest of what they hold; if it differs they send
each other their manifests and each takes what it lacks (`Engine.receive`).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
from pathlib import Path
from typing import Any

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from graite.cloud.session import get_cloud
from graite.sync import account, crypto
from graite.sync.engine import Engine, Unavailable
from graite.sync.state import Entry, entry_from_wire

log = logging.getLogger("graite.sync")

SYNC_PATH = "/sync/v1/connect"
MAX_BACKOFF = 60.0
INLINE_MAX = 256 * 1024  # larger files are fetched from a device, in chunks of this size
MANIFEST_PART = 400
FETCH_TIMEOUT = 120.0
SETTLE_SECONDS = 1.0  # wait this long after the last change before scanning
RESCAN_SECONDS = 60.0
WATCHED = ('"file_changed"', '"tree_changed"', '"table_changed"', '"policy_changed"')
# Close codes Graite Cloud uses (graite-inference sync/registry.py).
CLOSE_REPLACED = 4000
CLOSE_EXPIRED = 4001
CLOSE_UNAUTHORIZED = 4401
CLOSE_REMOVED = 4403

SIGN_IN_AGAIN = "Sign in to Graite Cloud again to keep syncing."
REPLACED = "This vault is open in another Graite window, which is syncing it."
REMOVED = "This device was removed from sync. Turn sync on again to rejoin."
LOCKED = "Enter your sync passphrase to keep syncing."


def ws_url(cloud_url: str) -> str:
    base = cloud_url.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base.removeprefix("https://") + SYNC_PATH
    return "ws://" + base.removeprefix("http://") + SYNC_PATH


class SyncService:
    """One background task that keeps this vault in step with its other devices."""

    def __init__(self, app: Any) -> None:
        self._app = app
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self.connected = False
        self.error: str | None = None
        # replica id → {"device", "digest"} of the devices connected right now.
        self.peers: dict[str, dict[str, Any]] = {}
        self.digest: str | None = None
        self._socket: ClientConnection | None = None
        self._send_lock = asyncio.Lock()
        self._engine: Engine | None = None
        self._key = b""
        self._replica = ""
        # Received versions waiting to be applied; an item without an entry only carries the
        # number of one of this device's own changes, to confirm in order.
        self._incoming: asyncio.Queue[tuple[Entry | None, str, bytes | None, int | None]] = (
            asyncio.Queue()
        )
        # Versions sent and not confirmed by Graite Cloud yet, by the id they were sent with.
        self._unconfirmed: dict[int, Entry] = {}
        self._fetches: dict[str, tuple[str, Path, asyncio.Future[bool]]] = {}
        self._asked: dict[str, str | None] = {}
        self._next_id = 0
        # Calls to and from this account's other devices (graite/compute), set by the app.
        self.compute: Any = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="sync")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def poke(self) -> None:
        """Sync was switched, or the sign-in changed: look again now."""
        self._wake.set()

    @property
    def waiting(self) -> int:
        """Versions received and not applied yet."""
        return self._incoming.qsize()

    async def _wait(self, seconds: float | None) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), seconds)
        self._wake.clear()

    # ----------------------------------------------------------------- connection

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            self.connected, self.peers = False, {}
            joined = account.joined(self._app.state.db)
            if joined is None:
                self.error = None
                await self._wait(None)
                continue
            space_id, self._replica = joined
            if not account.mark_file(self._app.state.settings.vault).is_file():
                # Synced before the mark existed, or `.graite` was rebuilt.
                account.mark(self._app.state.settings.vault, space_id)
            try:
                key = await asyncio.to_thread(account.space_key, space_id)
                token = await get_cloud().access_token()
            except ValueError as exc:  # unreachable, or the keychain is locked
                self.error = str(exc)
                await self._wait(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF)
                continue
            if token is None or key is None:
                self.error = SIGN_IN_AGAIN if token is None else LOCKED
                await self._wait(60)
                continue
            self._key = key
            try:
                async with connect(
                    ws_url(get_cloud().cloud_url),
                    additional_headers={"Authorization": f"Bearer {token}"},
                    open_timeout=15,
                    max_size=4 * 1024 * 1024,
                ) as socket:
                    await socket.send(json.dumps({"type": "hello", "space_id": space_id}))
                    self._socket = socket
                    self._engine = self._make_engine(space_id)
                    self.connected, self.error, backoff = True, None, 1.0
                    log.info("sync connected")
                    await self._serve(socket)
            except ConnectionClosed as exc:
                code = exc.rcvd.code if exc.rcvd else None
                log.info("sync closed (%s)", code)
                self.connected = False
                if code == CLOSE_EXPIRED:
                    continue
                if code in (CLOSE_REPLACED, CLOSE_REMOVED):
                    self.error = REPLACED if code == CLOSE_REPLACED else REMOVED
                    await self._wait(None)  # until the user switches sync again
                    continue
                if code == CLOSE_UNAUTHORIZED:
                    self.error = SIGN_IN_AGAIN
                    await self._wait(300)
                    continue
                self.error = "Sync lost its connection. Reconnecting…"
            except InvalidStatus as exc:
                self.error = f"Graite Cloud returned HTTP {exc.response.status_code}."
            except (OSError, TimeoutError) as exc:
                self.error = "Graite Cloud can’t be reached. Retrying…"
                log.info("sync unreachable: %s", exc.__class__.__name__)
            finally:
                self._socket = None
                self._fail_fetches(None)
                if self.compute is not None:
                    self.compute.lost(None)
            self.connected = False
            await self._wait(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF)

    def _make_engine(self, space_id: str) -> Engine:
        state = self._app.state
        return Engine(
            vault=state.settings.vault,
            db=state.db,
            fileops=state.fileops,
            watcher=state.watcher,
            proposals=state.proposals,
            space_id=space_id,
            replica_id=self._replica,
            device_name=lambda replica: str(
                self.peers.get(replica, {}).get("device") or "another device"
            ),
        )

    async def _serve(self, socket: ClientConnection) -> None:
        """Run until the socket closes, or sync is switched off for this vault."""
        self._incoming = asyncio.Queue()
        self._asked = {}
        self._unconfirmed = {}
        tasks = [
            asyncio.create_task(self._read(socket), name="sync:read"),
            asyncio.create_task(self._apply(), name="sync:apply"),
            asyncio.create_task(self._watch(), name="sync:watch"),
        ]
        try:
            while not tasks[0].done():
                waiter = asyncio.create_task(self._wake.wait())
                await asyncio.wait({tasks[0], waiter}, return_when=asyncio.FIRST_COMPLETED)
                if not waiter.done():
                    waiter.cancel()
                    continue
                self._wake.clear()
                if account.joined(self._app.state.db) is None:
                    await socket.close()
            await tasks[0]  # re-raises ConnectionClosed with the cloud's close code
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _send(self, frame: dict[str, Any]) -> None:
        socket = self._socket
        if socket is None:
            return
        with contextlib.suppress(ConnectionClosed):
            async with self._send_lock:
                await socket.send(json.dumps(frame))

    def _seal(self, payload: dict[str, Any]) -> str:
        return crypto.b64(crypto.seal(self._key, json.dumps(payload).encode("utf-8")))

    def _open(self, sealed: Any) -> dict[str, Any] | None:
        """None for anything not sealed with this space's key: it is dropped, never acted on."""
        try:
            opened = json.loads(crypto.open_sealed(self._key, crypto.unb64(str(sealed))))
        except ValueError:
            return None
        return opened if isinstance(opened, dict) else None

    async def _to_peer(self, peer: str, payload: dict[str, Any]) -> None:
        await self._send({"type": "peer", "to": peer, "payload": self._seal(payload)})

    async def to_peer(self, peer: str, payload: dict[str, Any]) -> None:
        """One message to another device, for the calls in `graite/compute`. ValueError when
        this vault is not connected."""
        if self._socket is None:
            raise ValueError("This computer is not connected to your other devices right now.")
        await self._to_peer(peer, payload)

    # ----------------------------------------------------------------- this device's changes

    async def _watch(self) -> None:
        """Scan when the vault changed (and now and then regardless), then tell the others."""
        loop = asyncio.get_running_loop()
        await self._publish()
        async with self._app.state.events.subscribe() as queue:
            due = loop.time() + RESCAN_SECONDS
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), max(0.0, due - loop.time()))
                except TimeoutError:
                    message = None
                if message is not None:
                    if not any(kind in message for kind in WATCHED):
                        continue
                    await asyncio.sleep(SETTLE_SECONDS)  # let a burst of saves finish
                    while not queue.empty():
                        queue.get_nowait()
                due = loop.time() + RESCAN_SECONDS
                await self._publish()
                await self._reconcile()

    async def _publish(self) -> None:
        """Send the versions this device made, then say what it holds now."""
        engine = self._engine
        assert engine is not None
        await engine.scan()
        await self._flush()

    async def _flush(self) -> None:
        """Send every version the others have not been told about, then this device's state.
        A version stays unsent until Graite Cloud confirms it, so one written while the
        connection was down goes out when it is back."""
        engine = self._engine
        assert engine is not None
        waiting = {(e.path, e.hash) for e in self._unconfirmed.values()}
        for entry in await asyncio.to_thread(engine.state.unsent):
            if (entry.path, entry.hash) in waiting:
                continue
            content: str | None = None
            if not entry.deleted and entry.size <= INLINE_MAX:
                held = engine.content(entry)
                if held is not None:
                    data = await asyncio.to_thread(held.read_bytes)
                    content = base64.b64encode(data).decode()
            self._next_id += 1
            self._unconfirmed[self._next_id] = entry
            payload = self._seal({"entry": entry.wire(), "content": content})
            await self._send({"type": "op", "id": self._next_id, "payload": payload})
        digest = await asyncio.to_thread(
            lambda: crypto.state_digest(self._key, engine.state.live())
        )
        if digest != self.digest:
            self.digest = digest
            await self._send({"type": "state", "digest": digest})

    async def _reconcile(self) -> None:
        """Ask each connected device that holds something else for its manifest, once per
        state it reports."""
        agreed = False
        for peer, info in self.peers.items():
            if peer == self._replica:
                continue
            if info.get("digest") == self.digest:
                agreed = True
            elif self._asked.get(peer, "") != info.get("digest"):
                self._asked[peer] = info.get("digest")
                await self._to_peer(peer, {"t": "manifest_req"})
        if agreed and self._engine is not None and not self.waiting:
            await asyncio.to_thread(self._engine.mark_agreed)

    # ----------------------------------------------------------------- the other devices'

    async def _read(self, socket: ClientConnection) -> None:
        async for raw in socket:
            try:
                frame = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(frame, dict):
                continue
            kind, sender = frame.get("type"), str(frame.get("from") or "")
            if kind == "presence":
                peers = frame.get("peers")
                self.peers = {
                    str(p["replica_id"]): p
                    for p in (peers if isinstance(peers, list) else [])
                    if isinstance(p, dict) and p.get("replica_id")
                }
                await self._reconcile()
            elif kind == "op":
                seq = frame.get("seq") if isinstance(frame.get("seq"), int) else None
                opened = self._open(frame.get("payload"))
                if opened is None or not self._queue(
                    opened.get("entry"), sender, opened.get("content"), seq
                ):
                    # Nothing to apply, but the number still counts as dealt with.
                    self._incoming.put_nowait((None, sender, None, seq))
            elif kind == "sent":
                confirmed = self._unconfirmed.pop(frame.get("id"), None)  # type: ignore[arg-type]
                if confirmed is not None and self._engine is not None:
                    await asyncio.to_thread(self._engine.state.mark_sent, confirmed)
                if isinstance(frame.get("seq"), int):
                    self._incoming.put_nowait((None, "", None, frame["seq"]))
            elif kind == "peer":
                opened = self._open(frame.get("payload"))
                if opened is not None:
                    await self._from_peer(sender, opened)
            elif kind == "peer_gone":
                self._fail_fetches(str(frame.get("to") or ""))
                if self.compute is not None:
                    self.compute.lost(str(frame.get("to") or ""))

    def _queue(self, raw: Any, sender: str, content: Any = None, seq: int | None = None) -> bool:
        try:
            entry = entry_from_wire(raw)
            data = base64.b64decode(content) if isinstance(content, str) else None
        except ValueError:
            return False  # not a path that syncs, or not an entry: never touches the disk
        self._incoming.put_nowait((entry, sender, data, seq))
        return True

    async def _from_peer(self, sender: str, message: dict[str, Any]) -> None:
        kind = message.get("t")
        engine = self._engine
        assert engine is not None
        if kind == "manifest_req":
            entries = [e.wire() for e in await asyncio.to_thread(engine.state.entries)]
            for start in range(0, max(len(entries), 1), MANIFEST_PART):
                part = entries[start : start + MANIFEST_PART]
                await self._to_peer(sender, {"t": "manifest", "entries": part})
        elif kind == "manifest":
            received = message.get("entries")
            for raw in received if isinstance(received, list) else []:
                self._queue(raw, sender)
        elif kind == "get":
            asyncio.create_task(self._serve_blob(sender, message))
        elif kind == "blob":
            await self._on_blob(sender, message)
        elif isinstance(kind, str) and kind.startswith("c_") and self.compute is not None:
            await self.compute.on_message(sender, message)

    async def _apply(self) -> None:
        """Apply received versions one at a time, in the order they came, and confirm each
        numbered one to Graite Cloud so it can stop keeping it for this device."""
        engine = self._engine
        assert engine is not None
        while True:
            entry, sender, data, seq = await self._incoming.get()
            if entry is not None:
                await self._apply_one(engine, entry, sender, data)
            if seq is not None:
                await self._send({"type": "ack", "seq": seq})
            if self._incoming.empty():
                await self._flush()
                await self._reconcile()

    async def _apply_one(
        self, engine: Engine, entry: Entry, sender: str, data: bytes | None
    ) -> None:
        async def fetch() -> Path | None:
            if data is not None:
                target = engine.temp()
                await asyncio.to_thread(target.write_bytes, data)
                return target
            return await self._fetch(sender, entry)

        try:
            await engine.receive(entry, fetch)
        except Unavailable:
            # The device that has the bytes is not connected; its manifest is asked for
            # again when it is back.
            self._asked.pop(sender, None)
        except Exception:
            log.exception("a synced change could not be applied")

    # ----------------------------------------------------------------- file bytes

    async def _fetch(self, peer: str, entry: Entry) -> Path | None:
        """Ask a device for the bytes of a version; None when it cannot give them."""
        engine = self._engine
        assert engine is not None
        self._next_id += 1
        fetch_id = str(self._next_id)
        target = engine.temp()
        target.touch()
        done: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._fetches[fetch_id] = (peer, target, done)
        await self._to_peer(
            peer, {"t": "get", "id": fetch_id, "path": entry.path, "hash": entry.hash}
        )
        try:
            ok = await asyncio.wait_for(done, FETCH_TIMEOUT)
        except TimeoutError:
            ok = False
        finally:
            self._fetches.pop(fetch_id, None)
        if not ok:
            target.unlink(missing_ok=True)
            return None
        return target

    async def _on_blob(self, sender: str, message: dict[str, Any]) -> None:
        found = self._fetches.get(str(message.get("id")))
        if found is None or found[0] != sender or found[2].done():
            return
        _, target, done = found
        if message.get("missing"):
            done.set_result(False)
            return
        try:
            data = base64.b64decode(str(message.get("data") or ""))
        except ValueError:
            done.set_result(False)
            return

        def append() -> None:
            with target.open("ab") as handle:
                handle.write(data)

        await asyncio.to_thread(append)
        if message.get("last"):
            done.set_result(True)

    def _fail_fetches(self, peer: str | None) -> None:
        for waiting_peer, _, done in self._fetches.values():
            if (peer is None or waiting_peer == peer) and not done.done():
                done.set_result(False)

    async def _serve_blob(self, peer: str, message: dict[str, Any]) -> None:
        engine = self._engine
        assert engine is not None
        fetch_id = message.get("id")
        held = engine.state.get(str(message.get("path") or ""))
        source = (
            engine.content(held) if held is not None and held.hash == message.get("hash") else None
        )
        if source is None:
            await self._to_peer(peer, {"t": "blob", "id": fetch_id, "missing": True})
            return
        try:
            with source.open("rb") as handle:
                chunk = await asyncio.to_thread(handle.read, INLINE_MAX)
                while True:
                    following = await asyncio.to_thread(handle.read, INLINE_MAX)
                    await self._to_peer(
                        peer,
                        {
                            "t": "blob",
                            "id": fetch_id,
                            "data": base64.b64encode(chunk).decode(),
                            "last": not following,
                        },
                    )
                    if not following:
                        break
                    chunk = following
        except OSError:
            await self._to_peer(peer, {"t": "blob", "id": fetch_id, "missing": True})
