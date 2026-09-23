from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import httpx
import pytest

from graite.events import EventBus
from graite.index import db
from graite.models.downloader import CatalogModel, Downloader


def fixture(tmp_path: Path) -> tuple[Any, Downloader, CatalogModel]:
    conn = db.connect(tmp_path / "index.sqlite")
    manager = Downloader(conn, EventBus(), tmp_path / "models")
    item = next(iter(manager.items.values()))
    item.size = 6
    item.sha256 = hashlib.sha256(b"abcdef").hexdigest()
    return conn, manager, item


async def test_resume_verifies_and_publishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    conn, manager, item = fixture(tmp_path)
    partial = manager.target(item).with_suffix(".part")
    partial.parent.mkdir(parents=True)
    partial.write_bytes(b"abc")

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.headers["range"] == "bytes=3-"
        return httpx.Response(206, content=b"def", headers={"content-range": "bytes 3-5/6"})

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    try:
        await manager.download(item)
        assert item.status == "installed"
        assert manager.target(item).read_bytes() == b"abcdef"
        assert not partial.exists()
        assert conn.execute("SELECT state FROM model_downloads").fetchone()
    finally:
        conn.close()


async def test_bad_checksum_never_publishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    conn, manager, item = fixture(tmp_path)
    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"badbad")),
            **kwargs,
        ),
    )
    try:
        await manager.download(item)
        assert item.status == "error"
        assert not manager.target(item).exists()
        assert not manager.target(item).with_suffix(".part").exists()
    finally:
        conn.close()


async def test_resume_complete_partial_without_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    conn, manager, item = fixture(tmp_path)
    partial = manager.target(item).with_suffix(".part")
    partial.parent.mkdir(parents=True)
    partial.write_bytes(b"abcdef")

    def fail(**kwargs: Any) -> None:
        raise AssertionError("No HTTP request needed")

    monkeypatch.setattr(httpx, "AsyncClient", fail)
    try:
        await manager.download(item)
        assert item.status == "installed"
        assert manager.target(item).read_bytes() == b"abcdef"
    finally:
        conn.close()
