"""Sync between this account's devices: set it up, switch it on for this vault, see who is
up to date. The work itself is `graite/sync/`; file contents never pass through here."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from graite.sync import account, crypto

router = APIRouter(prefix="/sync", tags=["sync"])


class SyncDevice(BaseModel):
    id: str
    name: str
    platform: str | None = None
    this_device: bool
    connected: bool
    # Whether it holds what the device that synced last holds; None before its first sync.
    in_sync: bool | None = None
    last_sync_at: str | None = None


class SyncSpace(BaseModel):
    id: str
    name: str
    devices: list[SyncDevice]


class SyncStatus(BaseModel):
    signed_in: bool
    # Whether this account has a sync passphrase yet; None when Graite Cloud was not asked.
    set_up: bool | None = None
    # Whether this computer holds the account's key (the passphrase was entered here once).
    unlocked: bool = False
    # The space this vault syncs with, when sync is on for it.
    space_id: str | None = None
    connected: bool = False
    # Changes received from other devices and not applied yet.
    waiting: int = 0
    error: str | None = None
    # This account's synced vaults, with their devices. Names are readable once unlocked.
    spaces: list[SyncSpace] = []


class PassphraseOut(BaseModel):
    # None when this computer does not hold it (sync is not unlocked here).
    passphrase: str | None = None


class UnlockIn(BaseModel):
    passphrase: str = Field(min_length=1, max_length=200)


class EnableIn(BaseModel):
    # An existing space to join; omitted to start syncing this vault as a new one.
    space_id: str | None = None


def _space(raw: dict[str, Any], key: bytes | None) -> SyncSpace:
    return SyncSpace(
        id=str(raw["id"]),
        name=account.space_name(raw, key) if key else "Workspace",
        devices=[
            SyncDevice(
                id=str(r["id"]),
                name=str(r["device_name"]),
                platform=r.get("platform"),
                this_device=bool(r["this_device"]),
                connected=bool(r["connected"]),
                in_sync=r.get("in_sync"),
                last_sync_at=r.get("last_sync_at"),
            )
            for r in raw.get("replicas", [])
        ],
    )


async def _status(request: Request) -> SyncStatus:
    state = request.app.state
    service = state.sync
    joined = account.joined(state.db)
    status = SyncStatus(
        signed_in=False,
        space_id=joined[0] if joined else None,
        connected=service.connected,
        waiting=service.waiting,
        error=service.error,
    )
    try:
        key = await asyncio.to_thread(account.account_key)
        stored = await account.stored_keys()
        status.signed_in = True
        status.set_up = stored is not None
        # A key from before sync was reset on another device no longer opens anything.
        if key is not None and (stored is None or not crypto.check_account_key(key, stored)):
            key = None
        status.unlocked = key is not None
        if stored is not None:
            status.spaces = [_space(raw, key) for raw in await account.spaces()]
        if joined and joined[0] not in {space.id for space in status.spaces}:
            # The vault this folder synced with is gone (sync was reset): ask again.
            account.set_joined(state.db, None, None)
            service.poke()
            status.space_id, status.connected, status.error = None, False, None
    except ValueError as exc:
        if str(exc) != account.SIGN_IN:
            status.error = status.error or str(exc)
    return status


@router.get("/status", response_model=SyncStatus)
async def status(request: Request) -> SyncStatus:
    return await _status(request)


@router.post("/setup", response_model=SyncStatus)
async def setup(request: Request) -> SyncStatus:
    """Set sync up for the account (once): makes its keys and a six-word passphrase on this
    computer. Graite Cloud never sees the passphrase; `/passphrase` shows it."""
    try:
        await account.set_up()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return await _status(request)


@router.get("/passphrase", response_model=PassphraseOut)
async def passphrase() -> PassphraseOut:
    """The passphrase to type on another device. Only a computer that is unlocked has it."""
    try:
        return PassphraseOut(passphrase=await asyncio.to_thread(account.passphrase))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/unlock", response_model=SyncStatus)
async def unlock(body: UnlockIn, request: Request) -> SyncStatus:
    """Enter the passphrase on a device that does not have the key."""
    try:
        joined = account.joined(request.app.state.db)
        await account.unlock(body.passphrase, joined[0] if joined else None)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    request.app.state.sync.poke()
    return await _status(request)


@router.post("/reset", response_model=SyncStatus)
async def reset(request: Request) -> SyncStatus:
    """Start sync over for the account: for a forgotten passphrase or a lost device. No file
    on any device changes; every device enters the new passphrase and joins again."""
    state = request.app.state
    try:
        await account.reset()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    account.set_joined(state.db, None, None)
    state.sync.poke()
    return await _status(request)


@router.post("/enable", response_model=SyncStatus)
async def enable(body: EnableIn, request: Request) -> SyncStatus:
    """Sync this vault: as a new space, or with one this account already has."""
    state = request.app.state
    try:
        key = await asyncio.to_thread(account.account_key)
        stored = await account.stored_keys()
        if key is None or stored is None or not crypto.check_account_key(key, stored):
            raise ValueError("Enter your sync passphrase first.")
        space_id = body.space_id
        if space_id is None:
            space_id = str((await account.create_space(state.settings.vault.name, key))["id"])
        replica_id, space_key = await account.join(space_id, key)
        await asyncio.to_thread(account.set_space_key, space_id, space_key)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    account.set_joined(state.db, space_id, replica_id)
    state.sync.poke()
    return await _status(request)


@router.post("/disable", response_model=SyncStatus)
async def disable(request: Request) -> SyncStatus:
    """Stop syncing this vault on this device. The files stay; other devices keep syncing."""
    state = request.app.state
    joined = account.joined(state.db)
    if joined is not None:
        account.set_joined(state.db, None, None)
        state.sync.poke()
        try:
            await account.leave(*joined)
        except ValueError:
            pass  # offline: the device stays listed until it is removed from the account
    return await _status(request)
