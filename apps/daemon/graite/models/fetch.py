"""One verified, resumable download: used for models and for engine archives."""

from __future__ import annotations

import asyncio
import hashlib
import shutil
from collections.abc import Callable
from pathlib import Path

import httpx


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


async def fetch(
    url: str,
    target: Path,
    *,
    size: int,
    sha256: str,
    on_progress: Callable[[int], None] | None = None,
    on_verify: Callable[[], None] | None = None,
    what: str = "model",
) -> None:
    """Download `url` to `target`, resuming a `.part` file, and publish it only after the size
    and checksum match. A target that is already right is left alone."""
    partial = target.with_suffix(".part")

    def already_there() -> bool:
        return target.is_file() and target.stat().st_size == size and digest(target) == sha256

    if await asyncio.to_thread(already_there):
        return
    await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
    offset = partial.stat().st_size if partial.exists() else 0
    # A pause can arrive after the final byte but before checksum verification.
    if offset >= size:
        if offset == size and await asyncio.to_thread(digest, partial) == sha256:
            await asyncio.to_thread(partial.replace, target)
            return
        await asyncio.to_thread(partial.unlink, missing_ok=True)
        offset = 0
    free = await asyncio.to_thread(shutil.disk_usage, target.parent)
    if free.free < size - offset + 100_000_000:
        raise ValueError(f"Not enough free disk space for this {what}.")
    async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
        async with client.stream(
            "GET", url, headers={"Range": f"bytes={offset}-"} if offset else {}
        ) as response:
            response.raise_for_status()
            if response.status_code != 206:
                offset = 0
            elif not response.headers.get("content-range", "").startswith(f"bytes {offset}-"):
                raise ValueError("The download server returned an invalid resume range.")
            received = offset
            with partial.open("ab" if offset else "wb") as handle:
                async for chunk in response.aiter_bytes(1024 * 1024):
                    received += len(chunk)
                    if received > size:
                        raise ValueError(f"The download is larger than the pinned {what}.")
                    await asyncio.to_thread(handle.write, chunk)
                    if on_progress is not None:
                        on_progress(received)
    if on_verify is not None:
        on_verify()
    if partial.stat().st_size != size or await asyncio.to_thread(digest, partial) != sha256:
        await asyncio.to_thread(partial.unlink, missing_ok=True)
        raise ValueError("Checksum verification failed. Please download again.")
    await asyncio.to_thread(partial.replace, target)
