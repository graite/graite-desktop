"""Two daemons syncing through a fake Graite Cloud (graite/sync/client.py, api/sync.py).

The fake is the relay half of graite-inference's `/sync/v1/connect`: it passes frames between
the connected devices and reads none of them."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from nacl import pwhash
from websockets.exceptions import ConnectionClosed
from websockets.sync.server import Server, ServerConnection, serve

from graite.app import create_app
from graite.cloud.session import CloudSession, set_cloud
from graite.config import Settings
from graite.sync import account, client, crypto

TOKEN = "test-token"
SPACE = "11111111-1111-1111-1111-111111111111"


class FakeHub:
    """Hands each connection the next replica id in `order`, then relays."""

    def __init__(self) -> None:
        self.order: list[str] = []
        self.sockets: dict[str, ServerConnection] = {}
        self.digests: dict[str, str | None] = {}
        # Like Graite Cloud: every op numbered and kept until all known devices confirmed it.
        self.queue: list[tuple[int, str, str]] = []
        self.acked: dict[str, int] = {}
        self.seq = 0
        self.lock = threading.Lock()
        self.server: Server = serve(self.handle, "127.0.0.1", 0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.socket.getsockname()[1]}"

    def presence(self) -> None:
        peers = [
            {"replica_id": r, "device": r.title(), "digest": self.digests.get(r)}
            for r in self.sockets
        ]
        self.broadcast({"type": "presence", "peers": peers}, skip=None)

    def broadcast(self, frame: dict[str, Any], skip: str | None) -> None:
        for replica, socket in list(self.sockets.items()):
            if replica != skip:
                try:
                    socket.send(json.dumps(frame))
                except ConnectionClosed:
                    pass

    def handle(self, socket: ServerConnection) -> None:
        hello = json.loads(socket.recv())
        assert hello == {"type": "hello", "space_id": SPACE}
        with self.lock:
            replica = self.order.pop(0)
            self.sockets[replica] = socket
            socket.send(json.dumps({"type": "welcome", "replica_id": replica}))
            seen = self.acked.setdefault(replica, self.seq)
            for seq, author, payload in self.queue:
                if seq > seen and author != replica:
                    out = {"type": "op", "from": author, "seq": seq, "payload": payload}
                    socket.send(json.dumps(out))
            self.presence()
        try:
            for raw in socket:
                frame = json.loads(raw)
                with self.lock:
                    if frame["type"] == "op":
                        self.seq += 1
                        self.queue.append((self.seq, replica, frame["payload"]))
                        out = {"type": "op", "from": replica, "seq": self.seq}
                        self.broadcast({**out, "payload": frame["payload"]}, skip=replica)
                        sent = {"type": "sent", "id": frame["id"], "seq": self.seq}
                        socket.send(json.dumps(sent))
                    elif frame["type"] == "ack":
                        self.acked[replica] = max(self.acked.get(replica, 0), frame["seq"])
                        # Kept while a device other than its author has not confirmed it.
                        self.queue = [
                            op
                            for op in self.queue
                            if any(seen < op[0] for who, seen in self.acked.items() if who != op[1])
                        ]
                    elif frame["type"] == "peer":
                        target = self.sockets.get(frame["to"])
                        if target is None:
                            socket.send(json.dumps({"type": "peer_gone", "to": frame["to"]}))
                        else:
                            out = {"type": "peer", "from": replica, "payload": frame["payload"]}
                            target.send(json.dumps(out))
                    elif frame["type"] == "state":
                        self.digests[replica] = frame["digest"]
                        self.presence()
        except ConnectionClosed:
            pass
        finally:
            with self.lock:
                if self.sockets.get(replica) is socket:
                    del self.sockets[replica]
                self.presence()


@pytest.fixture
def hub(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeHub]:
    async def token(self: CloudSession) -> str:
        return "cloud-access-token"

    monkeypatch.setattr(CloudSession, "access_token", token)
    monkeypatch.setattr(client, "SETTLE_SECONDS", 0.05)
    monkeypatch.setattr(client, "RESCAN_SECONDS", 0.3)
    fake = FakeHub()
    try:
        yield fake
    finally:
        fake.server.shutdown()


class Device:
    def __init__(self, tmp_path: Path, hub: FakeHub, replica: str, key: bytes) -> None:
        self.replica, self.hub, self.key = replica, hub, key
        self.settings = Settings(  # type: ignore[call-arg]
            _env_file=None,
            vault=tmp_path / replica,
            token=TOKEN,
            no_watch=True,
            app_dir=tmp_path / "app",
            cloud_url=hub.url,
        )
        self.web: TestClient | None = None

    @property
    def vault(self) -> Path:
        vault: Path = self.settings.vault
        return vault

    def start(self) -> None:
        self.hub.order.append(self.replica)
        self.web = TestClient(
            create_app(self.settings), headers={"Authorization": f"Bearer {TOKEN}"}
        )
        self.web.__enter__()
        state = self.web.app.state  # type: ignore[attr-defined]
        account.set_space_key(SPACE, self.key)
        account.set_joined(state.db, SPACE, self.replica)
        assert self.web.portal is not None
        self.web.portal.call(state.sync.poke)  # on the daemon's loop, as a request would
        wait(lambda: self.sync.connected and self.sync.digest is not None)
        # Synced before the mark existed: the service writes it when it starts.
        assert json.loads(account.mark_file(self.vault).read_text())["space_id"] == SPACE

    def stop(self) -> None:
        assert self.web is not None
        self.web.__exit__(None, None, None)
        self.web = None

    @property
    def sync(self) -> Any:
        assert self.web is not None
        return self.web.app.state.sync  # type: ignore[attr-defined]

    def run(self, call: Callable[[Any], Any]) -> Any:
        """Run a coroutine function on the daemon's own event loop."""
        assert self.web is not None and self.web.portal is not None
        state = self.web.app.state  # type: ignore[attr-defined]

        async def inner() -> Any:
            return await call(state)

        return self.web.portal.call(inner)

    def text(self, path: str) -> str:
        return (self.vault / path).read_text(encoding="utf-8")


def wait(check: Callable[[], bool], seconds: float = 15) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except OSError:
            pass
        time.sleep(0.05)
    raise AssertionError("timed out")


def in_step(*devices: Device) -> bool:
    digests = {d.sync.digest for d in devices}
    return len(digests) == 1 and all(d.sync.waiting == 0 for d in devices)


@pytest.fixture
def devices(tmp_path: Path, hub: FakeHub) -> Iterator[tuple[Device, Device]]:
    key = crypto.new_key()
    pair = Device(tmp_path, hub, "laptop", key), Device(tmp_path, hub, "desk", key)
    for one in pair:
        one.start()
    try:
        yield pair
    finally:
        for one in pair:
            if one.web is not None:
                one.stop()


def test_changes_travel_between_two_running_daemons(devices: tuple[Device, Device]) -> None:
    laptop, desk = devices

    async def write(state: Any) -> str:
        doc = await state.fileops.create_page(None, "Plan", None, "ui")
        await state.fileops.write_body(doc.path, "Made on the laptop.\n", None, "ui")
        return str(doc.path)

    assert laptop.run(write) == "Plan"
    wait(lambda: "Made on the laptop." in desk.text("Plan/page.md"))
    # The page is indexed on the desk like any other, and an edit there travels back.
    page = desk.web.get("/api/v1/pages/Plan")  # type: ignore[union-attr]
    assert page.status_code == 200 and "Made on the laptop." in page.json()["body"]

    async def edit(state: Any) -> None:
        await state.fileops.write_body("Plan", "Made on the laptop.\n\nAnd the desk.\n", None, "ui")

    desk.run(edit)
    wait(lambda: "And the desk." in laptop.text("Plan/page.md"))
    wait(lambda: in_step(laptop, desk))


def test_large_files_are_fetched_from_the_other_device(
    devices: tuple[Device, Device], hub: FakeHub
) -> None:
    laptop, desk = devices
    data = bytes(range(256)) * 4000  # about 1 MB: several chunks
    (laptop.vault / "Media" / "_assets").mkdir(parents=True)
    (laptop.vault / "Media" / "page.md").write_text("---\ntitle: Media\n---\n", encoding="utf-8")
    (laptop.vault / "Media" / "_assets" / "clip.bin").write_bytes(data)
    wait(lambda: (desk.vault / "Media" / "_assets" / "clip.bin").read_bytes() == data)
    wait(lambda: in_step(laptop, desk))
    assert not list((desk.vault / ".graite" / "sync" / "tmp").iterdir())


def test_a_device_that_was_off_catches_up_both_ways(devices: tuple[Device, Device]) -> None:
    laptop, desk = devices
    (laptop.vault / "Notes").mkdir()
    (laptop.vault / "Notes" / "page.md").write_text("---\ntitle: Notes\n---\n\nOne.\n", "utf-8")
    wait(lambda: in_step(laptop, desk) and (desk.vault / "Notes" / "page.md").is_file())
    desk.stop()
    (laptop.vault / "Notes" / "page.md").write_text("---\ntitle: Notes\n---\n\nTwo.\n", "utf-8")
    (desk.vault / "Offline").mkdir()
    (desk.vault / "Offline" / "page.md").write_text("---\ntitle: Offline\n---\n\nHi.\n", "utf-8")
    wait(lambda: laptop.sync.peers.keys() == {"laptop"})
    desk.start()
    wait(lambda: "Two." in desk.text("Notes/page.md"))
    wait(lambda: "Hi." in laptop.text("Offline/page.md"))
    wait(lambda: in_step(laptop, desk))


def test_frames_not_sealed_with_the_space_key_are_dropped(
    devices: tuple[Device, Device], hub: FakeHub
) -> None:
    laptop, desk = devices
    stranger = crypto.new_key()
    entry = {
        "path": "Planted/page.md",
        "hash": "a" * 64,
        "size": 1,
        "vector": {"x": 1},
        "modified": 1,
        "author": "x",
    }
    forged = crypto.b64(crypto.seal(stranger, json.dumps({"entry": entry}).encode()))
    with hub.lock:
        hub.broadcast({"type": "op", "from": "laptop", "payload": forged}, skip="laptop")
        hub.broadcast({"type": "op", "from": "laptop", "payload": "not sealed"}, skip="laptop")
    # A path that may not sync, sealed correctly, is dropped too.
    bad = {**entry, "path": "../outside.md"}
    sealed = crypto.b64(crypto.seal(desk.key, json.dumps({"entry": bad}).encode()))
    with hub.lock:
        hub.broadcast({"type": "op", "from": "laptop", "payload": sealed}, skip="laptop")
    time.sleep(0.5)
    assert desk.sync.connected and desk.sync.waiting == 0
    assert not (desk.vault / "Planted").exists()
    assert not (desk.vault.parent / "outside.md").exists()


def test_changes_wait_in_the_cloud_for_a_device_that_is_off(
    devices: tuple[Device, Device], hub: FakeHub
) -> None:
    laptop, desk = devices
    (laptop.vault / "Notes").mkdir()
    (laptop.vault / "Notes" / "page.md").write_text("---\ntitle: Notes\n---\n\nOne.\n", "utf-8")
    wait(lambda: in_step(laptop, desk) and (desk.vault / "Notes" / "page.md").is_file())
    wait(lambda: hub.queue == [])  # both have it: nothing is kept
    desk.stop()
    (laptop.vault / "Notes" / "page.md").write_text("---\ntitle: Notes\n---\n\nTwo.\n", "utf-8")
    wait(lambda: len(hub.queue) == 1)
    # The laptop goes off too: the two devices are never on together again.
    laptop.stop()
    desk.start()
    wait(lambda: "Two." in desk.text("Notes/page.md"))
    wait(lambda: hub.queue == [])


def test_a_change_made_while_disconnected_is_sent_once_connected(
    devices: tuple[Device, Device], hub: FakeHub
) -> None:
    laptop, desk = devices
    desk.stop()
    laptop.stop()
    (laptop.vault / "Late").mkdir()
    (laptop.vault / "Late" / "page.md").write_text("---\ntitle: Late\n---\n\nHi.\n", "utf-8")
    laptop.start()
    wait(lambda: len(hub.queue) == 1)
    laptop.stop()
    desk.start()
    wait(lambda: "Hi." in desk.text("Late/page.md"))


# --- the API, against a fake of Graite Cloud's sync endpoints --------------------------------


class FakeApi:
    def __init__(self) -> None:
        self.keys: dict[str, Any] | None = None
        self.spaces: dict[str, dict[str, Any]] = {}
        self.replicas: dict[str, list[str]] = {}

    def _space(self, space_id: str) -> dict[str, Any]:
        return {
            **self.spaces[space_id],
            "id": space_id,
            "kind": "vault",
            "role": "owner",
            "replicas": [
                {
                    "id": replica,
                    "device_name": "This laptop",
                    "platform": "linux",
                    "this_device": True,
                    "connected": False,
                    "in_sync": None,
                    "last_sync_at": None,
                }
                for replica in self.replicas[space_id]
            ],
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else {}
        if path == "/api/v1/sync/keys":
            if method == "GET":
                found = self.keys
                return httpx.Response(200, json=found) if found else httpx.Response(404)
            if method == "DELETE":
                self.keys, self.spaces, self.replicas = None, {}, {}
                return httpx.Response(204)
            self.keys = body
            return httpx.Response(201, json=body)
        if path == "/api/v1/sync/spaces" and method == "GET":
            return httpx.Response(200, json={"spaces": [self._space(s) for s in self.spaces]})
        if path == "/api/v1/sync/spaces":
            self.spaces[SPACE], self.replicas[SPACE] = body, []
            return httpx.Response(201, json=self._space(SPACE))
        if path.endswith("/replicas") and method == "POST":
            self.replicas[SPACE] = ["replica-1"]
            return httpx.Response(200, json=self._space(SPACE))
        if method == "DELETE":
            self.replicas[SPACE] = []
            return httpx.Response(204)
        return httpx.Response(404)


def test_setting_up_unlocking_and_switching_sync_on(
    client: TestClient, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(crypto, "KDF_OPS", pwhash.argon2id.OPSLIMIT_MIN)
    monkeypatch.setattr(crypto, "KDF_MEM", pwhash.argon2id.MEMLIMIT_MIN)

    async def token(self: CloudSession) -> str:
        return "cloud-access-token"

    monkeypatch.setattr(CloudSession, "access_token", token)
    api = FakeApi()
    set_cloud(
        CloudSession(
            "http://127.0.0.1:9", settings.app_dir, transport=httpx.MockTransport(api.handler)
        )
    )
    status = client.get("/api/v1/sync/status").json()
    assert status["signed_in"] and status["set_up"] is False and not status["unlocked"]
    assert client.get("/api/v1/sync/passphrase").json() == {"passphrase": None}
    made = client.post("/api/v1/sync/setup")
    assert made.status_code == 200
    phrase = client.get("/api/v1/sync/passphrase").json()["passphrase"]
    assert len(phrase.split()) == 6
    assert made.json()["set_up"] and made.json()["unlocked"]
    # Graite Cloud got sealed values only.
    assert api.keys is not None and phrase.split()[0] not in json.dumps(api.keys)

    on = client.post("/api/v1/sync/enable", json={})
    assert on.status_code == 200 and on.json()["space_id"] == SPACE
    assert on.json()["spaces"][0]["name"] == settings.vault.name
    assert settings.vault.name not in json.dumps(api.spaces)
    assert on.json()["spaces"][0]["devices"][0]["this_device"] is True
    # The mark the desktop shell reads to show which vaults sync; it is only a convenience.
    mark = account.mark_file(settings.vault)
    assert json.loads(mark.read_text()) == {"space_id": SPACE, "name": settings.vault.name}
    mark.unlink()
    account.mark(settings.vault, SPACE, "Shared notes")
    assert json.loads(mark.read_text())["name"] == "Shared notes"
    client.get("/api/v1/sync/status")  # puts the real name back
    assert json.loads(mark.read_text())["name"] == settings.vault.name

    # A second device: the key is not in its keychain until the passphrase is entered.
    asyncio.run(asyncio.to_thread(account.set_account_key, None))
    assert client.get("/api/v1/sync/status").json()["unlocked"] is False
    assert client.get("/api/v1/sync/status").json()["spaces"][0]["name"] == "Workspace"
    wrong = client.post("/api/v1/sync/unlock", json={"passphrase": "wrong horse battery"})
    assert wrong.status_code == 400 and "passphrase" in wrong.json()["detail"]
    assert client.post("/api/v1/sync/unlock", json={}).status_code == 422
    opened = client.post(
        "/api/v1/sync/unlock", json={"passphrase": phrase.upper().replace(" ", "-")}
    )
    assert opened.status_code == 200 and opened.json()["unlocked"]
    assert client.get("/api/v1/sync/passphrase").json() == {"passphrase": phrase}
    # A device whose key store was emptied gets its vault's key back with the passphrase.
    held = asyncio.run(asyncio.to_thread(account.space_key, SPACE))
    asyncio.run(asyncio.to_thread(account.set_space_key, SPACE, None))
    client.post("/api/v1/sync/unlock", json={"passphrase": phrase.upper().replace(" ", "-")})
    assert held and asyncio.run(asyncio.to_thread(account.space_key, SPACE)) == held

    off = client.post("/api/v1/sync/disable")
    assert off.status_code == 200 and off.json()["space_id"] is None
    assert api.replicas[SPACE] == []
    assert not mark.exists()


def test_resetting_sync_starts_over_and_other_devices_notice(
    client: TestClient, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(crypto, "KDF_OPS", pwhash.argon2id.OPSLIMIT_MIN)
    monkeypatch.setattr(crypto, "KDF_MEM", pwhash.argon2id.MEMLIMIT_MIN)

    async def token(self: CloudSession) -> str:
        return "access-token"

    monkeypatch.setattr(CloudSession, "access_token", token)
    api = FakeApi()
    set_cloud(
        CloudSession(
            "http://127.0.0.1:9", settings.app_dir, transport=httpx.MockTransport(api.handler)
        )
    )
    client.post("/api/v1/sync/setup")
    assert client.post("/api/v1/sync/enable", json={}).json()["space_id"] == SPACE
    old_key = asyncio.run(asyncio.to_thread(account.account_key))

    assert account.mark_file(settings.vault).is_file()
    reset = client.post("/api/v1/sync/reset")
    assert reset.status_code == 200
    assert not account.mark_file(settings.vault).exists()
    assert reset.json()["set_up"] is False and not reset.json()["unlocked"]
    assert reset.json()["space_id"] is None and reset.json()["spaces"] == []
    assert api.keys is None
    assert client.get("/api/v1/sync/passphrase").json() == {"passphrase": None}

    # Another device chose the new passphrase: this one still holds the old key and space.
    asyncio.run(asyncio.to_thread(account.set_account_key, old_key))
    account.set_joined(client.app.state.db, SPACE, "replica-1")  # type: ignore[attr-defined]
    _, api.keys = crypto.make_account("a brand new passphrase")
    account.mark(settings.vault, SPACE)
    seen = client.get("/api/v1/sync/status").json()
    assert seen["set_up"] and not seen["unlocked"] and seen["space_id"] is None
    assert not account.mark_file(settings.vault).exists()
    assert client.post("/api/v1/sync/enable", json={}).status_code == 400
    opened = client.post("/api/v1/sync/unlock", json={"passphrase": "a brand new passphrase"})
    assert opened.json()["unlocked"]
