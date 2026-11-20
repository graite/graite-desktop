"""The account side of sync: keys in the OS keychain, and Graite Cloud's sync API.

Graite Cloud stores what `crypto.make_account` sealed and the list of devices per space. The
account key, the passphrase and each space key live in this computer's keychain (service
"Graite"), next to the Graite Cloud sign-in, never in a file.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

import httpx
import keyring

from graite.cloud.session import KEYCHAIN_DOWN, UNREACHABLE, get_cloud
from graite.sync import crypto
from graite.vault.paths import GRAITE_DIR

SIGN_IN = "Sign in to Graite Cloud under Settings → Graite Cloud first."


def _get_secret(name: str) -> bytes | None:
    try:
        stored = keyring.get_password("Graite", name)
    except Exception as exc:
        raise ValueError(KEYCHAIN_DOWN) from exc
    return crypto.unb64(stored) if stored else None


def _set_secret(name: str, value: bytes | None) -> None:
    try:
        if value is not None:
            keyring.set_password("Graite", name, crypto.b64(value))
        elif keyring.get_password("Graite", name):
            keyring.delete_password("Graite", name)
    except Exception as exc:
        raise ValueError(KEYCHAIN_DOWN) from exc


def _account_name() -> str:
    return "sync-account:" + get_cloud()._account()


def account_key() -> bytes | None:
    return _get_secret(_account_name())


def set_account_key(key: bytes | None) -> None:
    _set_secret(_account_name(), key)


def space_key(space_id: str) -> bytes | None:
    return _get_secret(f"sync-space:{space_id}")


def set_space_key(space_id: str, key: bytes | None) -> None:
    _set_secret(f"sync-space:{space_id}", key)


# --- which space this vault syncs (index meta: off again after `.graite/` is deleted) --------


def joined(db: sqlite3.Connection) -> tuple[str, str] | None:
    """(space id, this device's replica id) when sync is on for this vault."""
    rows = dict(
        db.execute("SELECT key, value FROM meta WHERE key IN ('sync_space', 'sync_replica')")
    )
    space, replica = rows.get("sync_space"), rows.get("sync_replica")
    return (space, replica) if space and replica else None


def set_joined(db: sqlite3.Connection, space_id: str | None, replica_id: str | None) -> None:
    db.execute("DELETE FROM meta WHERE key IN ('sync_space', 'sync_replica')")
    if space_id and replica_id:
        db.execute("INSERT INTO meta VALUES ('sync_space', ?)", (space_id,))
        db.execute("INSERT INTO meta VALUES ('sync_replica', ?)", (replica_id,))
    db.commit()


# --- the mark ------------------------------------------------------------------------------
#
# `.graite/sync.json` says "this vault syncs" to anything that cannot open the vault's
# database: the desktop shell lists the vaults on this computer and shows which ones sync.
# It follows the two rows above and is rewritten from them, so deleting it loses nothing.


def mark_file(vault: Path) -> Path:
    return vault / GRAITE_DIR / "sync.json"


def mark(vault: Path, space_id: str | None, name: str = "") -> None:
    """Write the mark for a vault that syncs (`name`: what the shared vault is called), or
    remove it. Never raises: the mark is a convenience."""
    file = mark_file(vault)
    try:
        if space_id is None:
            file.unlink(missing_ok=True)
            return
        wanted = json.dumps({"space_id": space_id, "name": name or vault.name})
        if not file.is_file() or file.read_text(encoding="utf-8") != wanted:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(wanted, encoding="utf-8")
    except OSError:
        pass


# --- Graite Cloud ---------------------------------------------------------------------------


async def call(method: str, path: str, body: dict[str, Any] | None = None) -> httpx.Response:
    """One request to Graite Cloud's sync API. ValueError when signed out or unreachable."""
    cloud = get_cloud()
    token = await cloud.access_token()
    if token is None:
        raise ValueError(SIGN_IN)
    try:
        async with httpx.AsyncClient(
            base_url=cloud.cloud_url,
            timeout=httpx.Timeout(20, connect=10),
            transport=cloud.transport,
        ) as client:
            response = await client.request(
                method, path, json=body, headers={"Authorization": f"Bearer {token}"}
            )
    except httpx.HTTPError as exc:
        raise ValueError(UNREACHABLE) from exc
    if response.status_code == 401:
        raise ValueError(SIGN_IN)
    if response.status_code == 403:
        raise ValueError("Sign in to Graite Cloud again to use sync.")
    return response


def _fail(response: httpx.Response) -> ValueError:
    try:
        message = response.json()["error"]["message"]
    except ValueError, KeyError, TypeError:
        message = f"Graite Cloud returned HTTP {response.status_code}."
    return ValueError(str(message))


async def stored_keys() -> dict[str, Any] | None:
    """What Graite Cloud holds for this account's sync, or None before it is set up."""
    response = await call("GET", "/api/v1/sync/keys")
    if response.status_code == 404:
        return None
    if not response.is_success:
        raise _fail(response)
    found: dict[str, Any] = response.json()
    return found


def passphrase() -> str | None:
    """The sync passphrase, when this computer has it: shown to add another device."""
    stored = _get_secret("sync-passphrase:" + get_cloud()._account())
    return stored.decode("utf-8") if stored else None


def _set_passphrase(value: str | None) -> None:
    _set_secret(
        "sync-passphrase:" + get_cloud()._account(), value.encode("utf-8") if value else None
    )


def _keep(key: bytes | None, phrase: str | None) -> None:
    set_account_key(key)
    _set_passphrase(phrase)


async def set_up() -> None:
    """Make this account's keys and its passphrase: six random words, made here, kept on this
    computer next to the key they protect, and never sent anywhere."""
    phrase = crypto.new_passphrase()
    key, stored = await asyncio.to_thread(crypto.make_account, phrase)
    response = await call("POST", "/api/v1/sync/keys", stored)
    if not response.is_success:
        raise _fail(response)
    await asyncio.to_thread(_keep, key, phrase)


async def unlock(passphrase: str, space_id: str | None = None) -> None:
    """Put the account key on this computer, from the passphrase; and the key of the space
    this vault syncs with, when this computer lost it (its key store was emptied)."""
    stored = await stored_keys()
    if stored is None:
        raise ValueError("Sync is not set up for this account yet.")
    key = await asyncio.to_thread(crypto.unlock_account, passphrase, stored)
    await asyncio.to_thread(_keep, key, crypto.normalize(passphrase))
    if space_id is None:
        return
    for space in await spaces():
        if str(space["id"]) == space_id:
            own = crypto.open_sealed(key, crypto.unb64(space["wrapped_space_key"]))
            await asyncio.to_thread(set_space_key, space_id, own)


async def reset() -> None:
    """Start sync over for the whole account: Graite Cloud forgets its keys, its synced
    vaults and whatever was waiting. The vaults on the devices are untouched; each device
    then enters the new passphrase and joins again."""
    response = await call("DELETE", "/api/v1/sync/keys")
    if not response.is_success:
        raise _fail(response)
    await asyncio.to_thread(_keep, None, None)


async def spaces() -> list[dict[str, Any]]:
    response = await call("GET", "/api/v1/sync/spaces")
    if not response.is_success:
        raise _fail(response)
    listed: list[dict[str, Any]] = response.json()["spaces"]
    return listed


def space_name(space: dict[str, Any], key: bytes) -> str:
    """A space's name, readable only with the account key."""
    try:
        own = crypto.open_sealed(key, crypto.unb64(space["wrapped_space_key"]))
        return crypto.open_sealed(own, crypto.unb64(space["name_enc"])).decode("utf-8")
    except ValueError, KeyError:
        return "Workspace"


async def create_space(name: str, key: bytes) -> dict[str, Any]:
    own = crypto.new_key()
    body = {
        "name_enc": crypto.b64(crypto.seal(own, name.encode("utf-8")[:200])),
        "wrapped_space_key": crypto.b64(crypto.seal(key, own)),
    }
    response = await call("POST", "/api/v1/sync/spaces", body)
    if not response.is_success:
        raise _fail(response)
    created: dict[str, Any] = response.json()
    return created


async def join(space_id: str, key: bytes) -> tuple[str, bytes]:
    """Make this device a copy of the space. Returns its replica id and the space key."""
    response = await call("POST", f"/api/v1/sync/spaces/{space_id}/replicas")
    if not response.is_success:
        raise _fail(response)
    space = response.json()
    replica = next(r["id"] for r in space["replicas"] if r["this_device"])
    return str(replica), crypto.open_sealed(key, crypto.unb64(space["wrapped_space_key"]))


async def leave(space_id: str, replica_id: str) -> None:
    await call("DELETE", f"/api/v1/sync/spaces/{space_id}/replicas/{replica_id}")
