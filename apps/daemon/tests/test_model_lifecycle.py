from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from graite.index import db
from graite.models.manager import Manager


@pytest.mark.parametrize("fails", [False, True])
async def test_embeddings_release_memory_after_each_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fails: bool
) -> None:
    model = tmp_path / "embedding.gguf"
    model.write_bytes(b"GGUFtest")
    conn = db.connect(tmp_path / "index.sqlite")
    manager = Manager(conn)
    monkeypatch.setattr("graite.models.hardware.detect", lambda: SimpleNamespace(available_gb=16))
    manager.embedding_server.start = AsyncMock()
    manager.embedding_server.stop = AsyncMock()
    try:
        try:
            async with manager.use_embedding(str(model), "mean", release=True):
                assert manager.embedding_path == str(model)
                stops_before = manager.embedding_server.stop.await_count
                if fails:
                    raise ValueError("embedding failed")
        except ValueError:
            assert fails
        assert manager.embedding_path == ""
        assert manager.embedding_server.stop.await_count == stops_before + 1
        async with manager.use_embedding(str(model), "mean", release=True):
            pass
        assert manager.embedding_server.start.await_count == 2
    finally:
        conn.close()


async def test_embedding_server_stays_loaded_for_batches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = tmp_path / "embedding.gguf"
    model.write_bytes(b"GGUFtest")
    conn = db.connect(tmp_path / "index.sqlite")
    manager = Manager(conn)
    monkeypatch.setattr("graite.models.hardware.detect", lambda: SimpleNamespace(available_gb=16))
    manager.embedding_server.start = AsyncMock()
    manager.embedding_server.stop = AsyncMock()
    manager.embedding_server.process = SimpleNamespace(returncode=None)
    try:
        async with manager.use_embedding(str(model), "mean"):
            pass
        async with manager.use_embedding(str(model), "mean"):
            pass
        assert manager.embedding_server.start.await_count == 1
        assert manager.embedding_path == str(model)
        await manager.release_embedding()
        assert manager.embedding_path == ""
    finally:
        conn.close()


async def test_cloud_providers_do_not_take_the_local_model_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.models.config import AIConfig

    conn = db.connect(tmp_path / "index.sqlite")
    manager = Manager(conn)
    monkeypatch.setattr("keyring.get_password", lambda *_: "key")
    try:
        config = AIConfig(provider="compatible", base_url="https://api.example/v1", model="m")
        async with manager.use(config) as provider:
            assert not manager.lock.locked()
            assert provider.kind == "compatible" and provider.max_tokens == 2048
            async with manager.use(config) as second:  # two cloud chats side by side
                assert second.model == "m"
        loaded = AIConfig(provider="local", model_path=str(tmp_path / "m.gguf"))
        manager.server.start = AsyncMock()
        manager.server.stop = AsyncMock()
        monkeypatch.setattr(
            "graite.models.hardware.detect", lambda: SimpleNamespace(available_gb=64)
        )
        async with manager.use(loaded):
            assert manager.lock.locked()
    finally:
        conn.close()


async def test_query_embedding_never_evicts_the_chat_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.models.manager import EmbeddingBusy

    model = tmp_path / "embedding.gguf"
    model.write_bytes(b"GGUFtest")
    conn = db.connect(tmp_path / "index.sqlite")
    manager = Manager(conn)
    monkeypatch.setattr("graite.models.hardware.detect", lambda: SimpleNamespace(available_gb=0))
    manager.server.process = SimpleNamespace(returncode=None)
    manager.server.stop = AsyncMock()
    manager.embedding_server.start = AsyncMock()
    manager.embedding_server.stop = AsyncMock()
    try:
        with pytest.raises(EmbeddingBusy):
            async with manager.use_embedding(str(model), "mean", evict_chat=False):
                pass
        assert manager.server.stop.await_count == 0
        async with manager.use_embedding(str(model), "mean"):
            pass
        assert manager.server.stop.await_count == 1  # bulk indexing may still make room
    finally:
        conn.close()


async def test_output_budget_changes_do_not_reload_a_resident_model(tmp_path: Path) -> None:
    from graite.models.config import AIConfig

    conn = db.connect(tmp_path / "index.sqlite")
    manager = Manager(conn)
    loaded = AIConfig(provider="local", model_path=str(tmp_path / "model.gguf"))
    manager.loaded = loaded
    manager.server.process = SimpleNamespace(returncode=None)
    manager.server.start = AsyncMock()
    manager.server.stop = AsyncMock()
    async with manager.use(loaded.model_copy(update={"max_output_tokens": 4096})) as provider:
        assert provider.max_tokens == 4096
    manager.server.start.assert_not_awaited()
    manager.server.stop.assert_not_awaited()
    conn.close()
