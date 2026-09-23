from __future__ import annotations

import hashlib
import io
import tarfile
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from graite.models import engines
from graite.models.engines import Archive, Engine, EngineInstaller, Variant, extract, recommend
from graite.models.hardware import Hardware

REAL_CLIENT = httpx.AsyncClient
SCRIPT = b"#!/bin/sh\necho fake-engine 1.0\nexit 0\n"
BROKEN = b"#!/bin/sh\nexit 3\n"


def tarball(
    files: dict[str, bytes], links: dict[str, str] | None = None, top: str = "pkg/"
) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, data in files.items():
            info = tarfile.TarInfo(top + name)
            info.size, info.mode = len(data), 0o755
            bundle.addfile(info, io.BytesIO(data))
        for name, target in (links or {}).items():
            info = tarfile.TarInfo(top + name)
            info.type, info.linkname = tarfile.SYMTYPE, target
            bundle.addfile(info)
    return buffer.getvalue()


def fake_engine(version: str, data: bytes, backend: str = "cpu") -> Engine:
    system, arch = engines.host()
    return Engine(
        id="crispasr",
        name="Voice engine",
        binary="crispasr",
        version=version,
        repo="x/y",
        license="MIT",
        purpose="Gives your assistant its voice.",
        variants=[
            Variant(
                id=f"{system}-{arch}-{backend}",
                os=system,
                arch=arch,
                backend=backend,
                label="Processor only",
                archives=[
                    Archive(
                        url=f"https://example.test/{version}/engine.tar.gz",
                        sha256=hashlib.sha256(data).hexdigest(),
                        size=len(data),
                    )
                ],
            )
        ],
    )


def serve(monkeypatch: pytest.MonkeyPatch, payloads: dict[str, bytes]) -> list[str]:
    asked: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(200, content=payloads[str(request.url)])

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handle), **kw)
    )
    return asked


HARDWARE = Hardware(ram_gb=32, available_gb=20)


def test_recommendation_prefers_metal_then_vulkan_and_never_cuda() -> None:
    catalog = {e.id: e for e in engines.catalog()}
    gpu = Hardware(ram_gb=32, available_gb=20, gpu="NVIDIA RTX 4070", backend="cuda12")
    assert recommend(catalog["llama"], gpu, "windows", "x64")[0].id == "windows-x64-vulkan"  # type: ignore[union-attr]
    assert recommend(catalog["llama"], gpu, "linux", "arm64")[0].id == "linux-arm64-vulkan"  # type: ignore[union-attr]
    assert recommend(catalog["llama"], HARDWARE, "linux", "x64")[0].id == "linux-x64-cpu"  # type: ignore[union-attr]
    assert recommend(catalog["crispasr"], HARDWARE, "darwin", "arm64")[0].id == "macos-arm64-metal"  # type: ignore[union-attr]
    # A graphics card, but only a processor build exists: say so in plain words.
    variant, reason = recommend(catalog["crispasr"], gpu, "linux", "arm64")
    assert variant is not None and variant.backend == "cpu" and "may be slow" in reason
    assert recommend(catalog["crispasr"], HARDWARE, "darwin", "x64") == (
        None,
        "There is no ready-made build for this computer yet.",
    )


def test_every_catalog_entry_is_pinned_with_a_checksum() -> None:
    for engine in engines.catalog():
        assert engine.version and engine.variants
        for variant in engine.variants:
            for archive in variant.archives:
                assert len(archive.sha256) == 64 and archive.size > 0
                assert archive.url.startswith(
                    f"https://github.com/{engine.repo}/releases/download/"
                )


async def test_install_verifies_tries_and_points_current_at_the_new_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = tarball({"crispasr": SCRIPT, "libx.so.1.2": b"lib"}, {"libx.so.1": "libx.so.1.2"})
    engine = fake_engine("v1", data)
    serve(monkeypatch, {engine.variants[0].archives[0].url: data})
    installer = EngineInstaller(tmp_path / "app")
    installer.engines = {engine.id: engine}
    assert installer.resolve("crispasr") is None or "app" not in str(installer.resolve("crispasr"))
    binary = await installer.install(engine, engine.variants[0])
    home = tmp_path / "app" / "bin" / "crispasr" / engine.variants[0].id
    assert binary == home / "v1" / "crispasr" and (home / "current").read_text().strip() == "v1"
    assert (home / "v1" / "libx.so.1").is_symlink() and not (home / ".downloads").exists()
    assert installer.installed("crispasr") == (engine.variants[0].id, "v1", binary)
    state = installer.state("crispasr", HARDWARE)
    assert (
        state.installed_version == "v1" and not state.update_available and state.path == str(binary)
    )

    # A newer pin: update available, install keeps the old version for a roll back.
    newer = tarball({"crispasr": SCRIPT + b"# v2\n"})
    engine2 = fake_engine("v2", newer)
    installer.engines = {engine2.id: engine2}
    assert installer.state("crispasr", HARDWARE).update_available is True
    serve(monkeypatch, {engine2.variants[0].archives[0].url: newer})
    await installer.install(engine2, engine2.variants[0])
    assert (home / "current").read_text().strip() == "v2" and (home / "v1").is_dir()
    assert installer.state("crispasr", HARDWARE).previous_version == "v1"
    await installer.rollback("crispasr")
    assert installer.installed("crispasr")[1] == "v1"  # type: ignore[index]

    # The user's own build (Advanced) wins over the installed one; a wrong path is an error,
    # not a silent fall back.
    own = tmp_path / "own-build"
    own.write_bytes(SCRIPT)
    assert installer.resolve("crispasr", str(own)) == own
    assert installer.resolve("crispasr", str(tmp_path / "missing")) is None
    await installer.remove("crispasr")
    assert installer.installed("crispasr") is None


async def test_a_bad_download_or_a_build_that_does_not_start_changes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    good = tarball({"crispasr": SCRIPT})
    engine = fake_engine("v1", good)
    installer = EngineInstaller(tmp_path / "app")
    installer.engines = {engine.id: engine}
    serve(monkeypatch, {engine.variants[0].archives[0].url: good})
    await installer.install(engine, engine.variants[0])

    tampered = fake_engine("v2", tarball({"crispasr": SCRIPT}))
    serve(monkeypatch, {tampered.variants[0].archives[0].url: b"x" * tampered.variants[0].size})
    with pytest.raises(ValueError, match="Checksum"):
        await installer.install(tampered, tampered.variants[0])

    broken_data = tarball({"crispasr": BROKEN})
    broken = fake_engine("v3", broken_data)
    serve(monkeypatch, {broken.variants[0].archives[0].url: broken_data})
    with pytest.raises(ValueError, match="could not start"):
        await installer.install(broken, broken.variants[0])

    empty_data = tarball({"README": b"nothing here"})
    empty = fake_engine("v4", empty_data)
    serve(monkeypatch, {empty.variants[0].archives[0].url: empty_data})
    with pytest.raises(ValueError, match="does not contain"):
        await installer.install(empty, empty.variants[0])
    assert installer.installed("crispasr")[1] == "v1"  # type: ignore[index]


@pytest.mark.parametrize(
    "build",
    [
        lambda: tarball({"../evil": b"x"}, top=""),
        lambda: tarball({"ok": b"x"}, {"link": "/etc/passwd"}),
        lambda: tarball({"ok": b"x"}, {"link": "../../outside"}),
    ],
)
def test_archives_cannot_write_outside_their_folder(tmp_path: Path, build: Any) -> None:
    archive = tmp_path / "engine.tar.gz"
    archive.write_bytes(build())
    with pytest.raises(ValueError, match="unsafe"):
        extract(archive, tmp_path / "out")
    assert not (tmp_path / "evil").exists()


def test_zip_archives_are_unpacked_without_their_top_folder(tmp_path: Path) -> None:
    archive = tmp_path / "engine.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("pkg/llama-server.exe", b"MZ")
        bundle.writestr("pkg/ggml.dll", b"dll")
    extract(archive, tmp_path / "out")
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["ggml.dll", "llama-server.exe"]
    evil = tmp_path / "evil.zip"
    with zipfile.ZipFile(evil, "w") as bundle:
        bundle.writestr("../escape.txt", b"x")
    with pytest.raises(ValueError, match="unsafe"):
        extract(evil, tmp_path / "out2")


def test_api_lists_engines_installs_in_the_scratch_app_dir_and_feeds_chat(
    client: TestClient, settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    import time

    listed = client.get("/api/v1/engines").json()
    assert [e["id"] for e in listed] == ["llama", "crispasr"]
    assert all(e["installed_version"] is None and e["purpose"] for e in listed)
    data = tarball({"crispasr": SCRIPT})
    engine = fake_engine("v9", data)
    client.app.state.engines.engines["crispasr"] = engine
    serve(monkeypatch, {engine.variants[0].archives[0].url: data})
    started = client.post("/api/v1/engines/crispasr/install", json={})
    assert started.status_code == 202
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        state = client.get("/api/v1/engines").json()[1]
        if state["installed_version"] or state["status"] == "error":
            break
        time.sleep(0.05)
    assert state["installed_version"] == "v9" and state["error"] is None
    assert str(settings.app_dir) in state["path"]  # never the user's real ~/.graite
    # Voice readiness now sees the engine without any path typed in.
    missing = {m["key"] for m in client.get("/api/v1/voice/status").json()["missing"]}
    assert "tts_engine" not in missing
    assert client.post("/api/v1/engines/nope/install", json={}).status_code == 404
    assert (
        client.post(
            "/api/v1/engines/crispasr/install", json={"variant": "plan9-x64-cpu"}
        ).status_code
        == 400
    )
    assert client.delete("/api/v1/engines/crispasr").json()["installed_version"] is None


def test_a_build_made_on_this_computer_wins_until_the_user_picks_another(tmp_path: Path) -> None:
    installer = EngineInstaller(tmp_path / "app")
    engine = fake_engine("v1", b"x")
    installer.engines = {engine.id: engine}
    home = tmp_path / "app" / "bin" / "crispasr"
    for variant, version in ((engine.variants[0].id, "v1"), ("local", "v1")):
        folder = home / variant / version
        folder.mkdir(parents=True)
        (folder / "crispasr").write_bytes(SCRIPT)
        (home / variant / "current").write_text(version + "\n")
    assert installer.installed("crispasr")[0] == "local"  # type: ignore[index]
    state = installer.state("crispasr", HARDWARE)
    assert state.installed_variant == "local" and not state.update_available
    assert "Built on this computer" in state.reason
    # Choosing a catalog build under Advanced records it, and then that one is used.
    (home / "variant").write_text(engine.variants[0].id + "\n")
    assert installer.installed("crispasr")[0] == engine.variants[0].id  # type: ignore[index]
    (home / "variant").write_text("local\n")
    assert installer.installed("crispasr")[0] == "local"  # type: ignore[index]
