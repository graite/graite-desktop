from __future__ import annotations

import hashlib
from pathlib import Path

import httpx
import pytest

from graite.events import EventBus
from graite.index import db
from graite.models.downloader import Downloader, ModelFile
from graite.models.hub import browse, entry, model_groups, repository, scan


@pytest.mark.parametrize(
    "value",
    [
        "other/Model-GGUF",
        "https://evil.test/unsloth/model",
        "unsloth/../model",
        "https://huggingface.co/unsloth/model?token=x",
        "unsloth/model/tree/main",
    ],
)
def test_rejects_unsupported_repository(value: str) -> None:
    with pytest.raises(ValueError):
        repository(value)


def test_repository_link() -> None:
    assert repository("https://huggingface.co/unsloth/Model-GGUF/") == "unsloth/Model-GGUF"


def test_groups_require_every_shard_and_ignore_projectors() -> None:
    files = [
        ModelFile(filename=n, size=4, sha256="")
        for n in [
            "Q4/model-00001-of-00002.gguf",
            "Q4/model-00002-of-00002.gguf",
            "Q8/model-00001-of-00002.gguf",
            "mmproj-F16.gguf",
            "model-Q5.gguf",
        ]
    ]
    groups = model_groups(files)
    assert [len(group) for group in groups] == [2, 1]


async def test_local_models_persist_and_removal_keeps_files(tmp_path: Path) -> None:
    folder = tmp_path / "originals"
    folder.mkdir()
    model = folder / "model.gguf"
    model.write_bytes(b"GGUFtest")
    (folder / "invalid.gguf").write_text("not a model")
    (folder / "link.gguf").symlink_to(model)
    models = scan(str(folder))
    assert len(models) == 1
    conn = db.connect(tmp_path / "index.sqlite")
    try:
        downloads = Downloader(conn, EventBus(), tmp_path / "downloads")
        item = downloads.register(models[0])
        restored = Downloader(conn, EventBus(), tmp_path / "downloads")
        assert restored.items[item.id].local_path == str(model)
        await restored.remove(item.id)
        assert model.read_bytes() == b"GGUFtest"
        assert item.id not in Downloader(conn, EventBus(), tmp_path / "downloads").items
    finally:
        conn.close()


async def test_browse_pins_checksums_and_filters_unsafe_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = httpx.AsyncClient
    checksum = "b" * 64

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "huggingface.co"
        return httpx.Response(
            200,
            json={
                "sha": "a" * 40,
                "siblings": [
                    {"rfilename": n, "lfs": {"sha256": checksum, "size": 123}}
                    for n in ["model-Q4.gguf", "../escape.gguf", "/absolute.gguf", "mmproj.gguf"]
                ],
            },
        )

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handle), **kw)
    )
    models = await browse("unsloth/model")
    assert len(models) == 1
    assert models[0].revision == "a" * 40
    assert models[0].files[0].sha256 == checksum


async def test_split_download_resume_and_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = b"GGUFabcd"
    files = [
        ModelFile(
            filename=f"Q4/model-{i:05}-of-00002.gguf",
            size=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
        )
        for i in [1, 2]
    ]
    model = entry("unsloth/model", "a" * 40, files)
    conn = db.connect(tmp_path / "index.sqlite")
    try:
        downloads = Downloader(conn, EventBus(), tmp_path / "downloads")
        downloads.register(model)
        first = downloads.file_target(model, files[0])
        first.parent.mkdir(parents=True)
        first.write_bytes(content)
        original = httpx.AsyncClient

        def handle(request: httpx.Request) -> httpx.Response:
            assert request.url.path.endswith("00002-of-00002.gguf")
            return httpx.Response(200, content=content)

        monkeypatch.setattr(
            httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handle), **kw)
        )
        await downloads.download(model)
        assert model.status == "installed"
        restored = Downloader(conn, EventBus(), tmp_path / "downloads")
        assert restored.items[model.id].status == "installed"
        downloads.file_target(model, files[1]).unlink()
        assert (
            Downloader(conn, EventBus(), tmp_path / "downloads").items[model.id].status
            == "available"
        )
    finally:
        conn.close()


def test_selecting_second_shard_registers_complete_model(tmp_path: Path) -> None:
    from graite.models.hub import local_file

    for i in [1, 2]:
        (tmp_path / f"model-{i:05}-of-00002.gguf").write_bytes(b"GGUFtest")
    item = local_file(str(tmp_path / "model-00002-of-00002.gguf"))
    assert item.local_path.endswith("00001-of-00002.gguf")
    assert len(item.files) == 2
    (tmp_path / "model-00001-of-00002.gguf").unlink()
    with pytest.raises(ValueError):
        local_file(str(tmp_path / "model-00002-of-00002.gguf"))


def test_importance_matrix_is_not_a_model(tmp_path: Path) -> None:
    from graite.models.hub import local_file

    path = tmp_path / "imatrix_unsloth.gguf"
    path.write_bytes(b"GGUFtest")
    with pytest.raises(ValueError):
        local_file(str(path))
