"""The user's app-wide profile (their first name)."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from graite.profile import Profile, ProfileStore, get_profile_store

router = APIRouter(prefix="/profile", tags=["Profile"])


def _store() -> ProfileStore:
    store = get_profile_store()
    if store is None:
        raise HTTPException(503, "The profile is not available in this daemon.")
    return store


@router.get("", response_model=Profile)
async def read_profile() -> Profile:
    return await asyncio.to_thread(_store().load)


@router.put("", response_model=Profile)
async def write_profile(body: Profile) -> Profile:
    return await asyncio.to_thread(_store().save, body)
