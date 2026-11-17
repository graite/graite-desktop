"""The newest upstream build of an engine, for people who switched on geek mode.

`engines.json` pins the build this Graite release was tested with. This module looks one step
further: it asks GitHub for the engine's newest release and maps its files onto the builds
Graite already knows (same platforms, same backends), so the normal installer can download,
verify, try and switch to it, with a roll back to what was there before.

Only files that GitHub publishes a SHA-256 digest for, served from the engine's own release
download URL, are accepted. Nothing else about the release is trusted: names are matched
against the pinned catalog, never taken from the release as instructions.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from graite.models.engine_versions import version_key
from graite.models.engines import Archive, Engine, Variant

GITHUB_API = "https://api.github.com"
RECENT = 15  # releases to look through for one that has every file a build needs


def _asset_pattern(name: str, old: str, new: str) -> re.Pattern[str]:
    """A pinned file name, as a pattern for the same file in another release: the version
    swapped, and a CUDA version allowed to move on (13.3 → 13.5)."""
    renamed = re.escape(name.replace(old, new))
    renamed = re.sub(r"cuda\\-\d+\\\.\d+", r"cuda-\\d+\\.\\d+", renamed)
    return re.compile(f"^{renamed}$")


def _digest(asset: dict[str, Any]) -> str | None:
    digest = str(asset.get("digest") or "")
    if not digest.startswith("sha256:") or len(digest) != 71:
        return None
    return digest[7:]


def map_release(engine: Engine, release: dict[str, Any]) -> Engine | None:
    """The pinned engine with every build moved to `release`'s files, or None when the
    release does not have them all (a source-only or notes-only release)."""
    tag = str(release.get("tag_name") or "")
    if not tag or release.get("draft"):
        return None
    prefix = f"https://github.com/{engine.repo}/releases/download/{tag}/"
    assets = [
        a
        for a in release.get("assets") or []
        if isinstance(a, dict) and str(a.get("browser_download_url", "")).startswith(prefix)
    ]
    variants: list[Variant] = []
    for variant in engine.variants:
        archives: list[Archive] = []
        for archive in variant.archives:
            pattern = _asset_pattern(archive.url.rsplit("/", 1)[-1], engine.version, tag)
            match = next((a for a in assets if pattern.match(str(a.get("name", "")))), None)
            sha256 = _digest(match) if match else None
            if match is None or sha256 is None or not isinstance(match.get("size"), int):
                break
            archives.append(
                Archive(url=str(match["browser_download_url"]), sha256=sha256, size=match["size"])
            )
        else:
            variants.append(variant.model_copy(update={"archives": archives}))
    if not variants:
        return None
    return engine.model_copy(update={"version": tag, "variants": variants})


async def newest(
    engine: Engine, *, transport: httpx.AsyncBaseTransport | None = None
) -> tuple[Engine, dict[str, Any]] | None:
    """The newest release of `engine` that Graite can install, with its release record."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "Graite"}
    try:
        async with httpx.AsyncClient(
            base_url=GITHUB_API, timeout=20, headers=headers, transport=transport
        ) as client:
            response = await client.get(
                f"/repos/{engine.repo}/releases", params={"per_page": RECENT}
            )
    except httpx.HTTPError as exc:
        raise ValueError("GitHub can’t be reached. Check your connection and try again.") from exc
    if response.status_code == 403:
        raise ValueError("GitHub asks to wait a moment before checking again.")
    if not response.is_success:
        raise ValueError(f"GitHub returned HTTP {response.status_code}.")
    releases = response.json()
    if not isinstance(releases, list):
        raise ValueError("GitHub sent an answer Graite does not understand.")
    found = [
        (mapped, release)
        for release in releases
        if isinstance(release, dict) and (mapped := map_release(engine, release)) is not None
    ]
    if not found:
        return None
    return max(found, key=lambda pair: version_key(pair[0].version))
