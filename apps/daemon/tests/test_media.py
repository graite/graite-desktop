from __future__ import annotations

import asyncio
import io
import time
import wave
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from graite.media.decode import audio_wav, page_count, render_page


def upload(
    client: TestClient, name: str = "voice.wav", data: bytes = b"audio"
) -> tuple[dict, dict]:
    page = client.post("/api/v1/pages", json={"title": "Media test"}).json()
    result = client.post(
        "/api/v1/media/upload", params={"page_id": page["id"], "name": name}, content=data
    )
    assert result.status_code == 200, result.text
    return page, result.json()


def wait_job(client: TestClient, id_: str) -> dict:
    for _ in range(100):
        job = client.get(f"/api/v1/media/jobs/{id_}").json()
        if job["status"] != "running":
            return job
        time.sleep(0.02)
    pytest.fail("Extraction did not finish")


def test_original_survives_rename_and_cannot_escape_vault(client: TestClient) -> None:
    page, file = upload(client, "../../a.wav", b"original")
    assert file["name"] == "a.wav"
    assert "/" not in file["file"]
    params = {"page_id": page["id"], "file": file["file"]}
    client.patch("/api/v1/pages/Media test", json={"title": "Renamed"})
    assert client.get("/api/v1/media/file", params=params).content == b"original"
    for name in ["../page.md", "../../.graite/index.sqlite", "/etc/passwd", "x/y.wav"]:
        assert client.get("/api/v1/media/file", params={**params, "file": name}).status_code == 400
    path = client.app.state.fileops.attachment_path(page["id"], "linked.wav")
    path.symlink_to("/etc/passwd")
    assert client.get("/api/v1/media/file", params={**params, "file": path.name}).status_code == 400
    assert (
        client.get(
            "/api/v1/media/file", params=params, headers={"Authorization": "bad"}
        ).status_code
        == 401
    )
    assert client.get("/api/v1/pages/Renamed").json()["body"] == ""


def test_upload_rejects_unsafe_and_empty_files(client: TestClient) -> None:
    page = client.post("/api/v1/pages", json={"title": "P"}).json()
    for name, content in [("script.html", b"x"), ("script.svg", b"x"), ("voice.wav", b"")]:
        assert (
            client.post(
                "/api/v1/media/upload",
                params={"page_id": page["id"], "name": name},
                content=content,
            ).status_code
            == 400
        )


@pytest.mark.parametrize("output", ["toggle", "page"])
def test_transcript_is_new_markdown_and_preserves_source(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, output: str
) -> None:
    page, file = upload(client)
    from graite.api import media

    monkeypatch.setattr(media, "audio_wav", lambda _: b"decoded")
    monkeypatch.setattr(
        media,
        "transcribe",
        AsyncMock(return_value={"text": "One sentence.\n\nSecond sentence.", "seconds": 1}),
    )
    client.app.state.downloads.items["whisper-large-v3-turbo-q8"].status = "installed"
    r = client.post(
        "/api/v1/media/extract",
        json={"page_id": page["id"], "file": file["file"], "name": "voice.wav", "output": output},
    )
    assert r.status_code == 200
    job = wait_job(client, r.json()["id"])
    assert job["status"] == "done", job
    assets = client.app.state.fileops.attachment_path(page["id"], file["file"]).parent
    if output == "toggle":
        # The text waits in the job for the editor; it is never written next to the original.
        assert job["text"] == "One sentence.\n\nSecond sentence."
        assert job["page"] is None and job["file"] == ""
    else:
        result = client.get("/api/v1/pages/" + job["page"]["path"]).json()["body"]
        assert "../_assets/" in result
        assert "One sentence." in result and file["file"] in result
        assert job["text"] == ""
    assert [p.name for p in assets.iterdir()] == [file["file"]]
    assert client.get("/api/v1/pages/Media test").json()["body"] == ""
    assert (
        client.get(
            "/api/v1/media/file", params={"page_id": page["id"], "file": file["file"]}
        ).content
        == b"audio"
    )


def test_missing_model_and_cancellation_are_recoverable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    page, file = upload(client)
    payload = {"page_id": page["id"], "file": file["file"], "name": "voice.wav"}
    job = wait_job(client, client.post("/api/v1/media/extract", json=payload).json()["id"])
    assert job["status"] == "error" and "Download Whisper" in job["error"]
    from graite.api import media

    monkeypatch.setattr(media, "audio_wav", lambda _: b"decoded")
    stopped = []

    async def slow(*args: object, **kwargs: object) -> dict:
        try:
            await asyncio.sleep(60)
            return {}
        finally:
            stopped.append(True)

    monkeypatch.setattr(media, "transcribe", slow)
    client.app.state.downloads.items["whisper-large-v3-turbo-q8"].status = "installed"
    id_ = client.post("/api/v1/media/extract", json=payload).json()["id"]
    for _ in range(100):
        if client.get(f"/api/v1/media/jobs/{id_}").json()["progress"] == "Transcribing on device…":
            break
        time.sleep(0.01)
    job = client.delete(f"/api/v1/media/jobs/{id_}").json()
    assert job["status"] == "cancelled" and stopped
    assert not client.app.state.models.lock.locked()


def test_pdf_pages_and_image_preview(tmp_path: Path, client: TestClient) -> None:
    a, b = Image.new("RGB", (500, 600), "white"), Image.new("RGB", (500, 600), "red")
    output = io.BytesIO()
    a.save(output, "PDF", save_all=True, append_images=[b])
    page, file = upload(client, "two pages.pdf", output.getvalue())
    params = {"page_id": page["id"], "file": file["file"]}
    assert client.get("/api/v1/media/info", params=params).json() == {"pages": 2}
    response = client.get("/api/v1/media/preview", params={**params, "page": 1})
    assert response.status_code == 200 and response.content.startswith(b"\x89PNG")
    assert client.get("/api/v1/media/preview", params={**params, "page": 2}).status_code == 400
    png = tmp_path / "image.png"
    a.save(png)
    assert page_count(png) == 1 and render_page(png).startswith(b"\x89PNG")


def test_decode_stereo_wav_to_whisper_format(tmp_path: Path) -> None:
    path = tmp_path / "recording.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(b"\x00" * 48000 * 4)
    with wave.open(io.BytesIO(audio_wav(path))) as wav:
        assert wav.getnchannels() == 1 and wav.getframerate() == 16000
        assert wav.getnframes() == 16000
    path.write_bytes(b"not audio")
    with pytest.raises(ValueError, match="decoded"):
        audio_wav(path)


def test_recording_on_navigation_is_attached_once(client: TestClient) -> None:
    page, file = upload(client)
    payload = {"page_id": page["id"], "file": file["file"], "name": file["name"]}
    for _ in range(2):
        assert client.post("/api/v1/media/attach-recording", json=payload).status_code == 200
    body = client.get("/api/v1/pages/Media test").json()["body"]
    assert body.count(file["file"]) == 1 and "```graite:media" in body


def test_completed_result_is_recovered_after_daemon_restart(
    settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.api import media
    from graite.app import create_app

    monkeypatch.setattr(media, "audio_wav", lambda _: b"decoded")
    monkeypatch.setattr(
        media, "transcribe", AsyncMock(return_value={"text": "Saved transcript.", "seconds": 1})
    )
    headers = {"Authorization": "Bearer test-token"}
    with TestClient(create_app(settings), headers=headers) as first:
        page, file = upload(first)
        first.app.state.downloads.items["whisper-large-v3-turbo-q8"].status = "installed"
        started = first.post(
            "/api/v1/media/extract",
            json={"page_id": page["id"], "file": file["file"], "name": file["name"]},
        ).json()
        done = wait_job(first, started["id"])
        assert done["status"] == "done"
    with TestClient(create_app(settings), headers=headers) as second:
        recovered = second.get("/api/v1/media/jobs/" + done["id"]).json()
        assert recovered["status"] == "done"
        assert recovered["text"] == "Saved transcript."


def test_media_move_preserves_original_and_appends_to_destination(client: TestClient) -> None:
    import yaml

    source, file = upload(client, data=b"original audio")
    target = client.post("/api/v1/pages", json={"title": "Destination"}).json()
    client.put(
        "/api/v1/pages/Destination", json={"body": "Existing notes", "base_hash": target["hash"]}
    )
    block = (
        "```graite:media\n"
        + yaml.safe_dump({"file": file["file"], "name": file["name"], "kind": "audio"})
        + "```"
    )
    saved = client.put(
        "/api/v1/pages/Media test",
        json={"body": "Before\n\n" + block + "\n\nAfter", "base_hash": source["hash"]},
    ).json()
    payload = {
        "source_id": source["id"],
        "target_path": "Destination",
        "file": file["file"],
        "block": block,
        "base_hash": saved["hash"],
    }
    result = client.post("/api/v1/media/move", json=payload)
    assert result.status_code == 200, result.text
    assert "graite:media" not in client.get("/api/v1/pages/Media test").json()["body"]
    body = client.get("/api/v1/pages/Destination").json()["body"]
    assert body.startswith("Existing notes\n\n")
    moved = yaml.safe_load(body.split("```graite:media\n")[1].split("```")[0])
    assert (
        client.get(
            "/api/v1/media/file", params={"page_id": target["id"], "file": moved["file"]}
        ).content
        == b"original audio"
    )
    assert (
        client.get(
            "/api/v1/media/file", params={"page_id": source["id"], "file": file["file"]}
        ).content
        == b"original audio"
    )
    # A stale retry must never append a duplicate or erase edits.
    assert client.post("/api/v1/media/move", json=payload).status_code == 409
    assert client.get("/api/v1/pages/Destination").json()["body"] == body


def test_media_move_rejects_active_jobs_and_unsafe_targets(client: TestClient) -> None:
    import yaml

    source, file = upload(client)
    block = "```graite:media\n" + yaml.safe_dump({**file, "job": "running-job"}) + "```"
    payload = {
        "source_id": source["id"],
        "target_path": "../outside",
        "file": file["file"],
        "block": block,
        "base_hash": source["hash"],
    }
    assert client.post("/api/v1/media/move", json=payload).status_code == 400
    payload["target_path"] = "Other"
    assert client.post("/api/v1/media/move", json=payload).status_code == 400


def test_media_move_rolls_back_destination_if_source_write_fails(client, monkeypatch) -> None:
    source, file = upload(client)
    target = client.post("/api/v1/pages", json={"title": "Rollback destination"}).json()
    client.post(
        "/api/v1/media/attach-recording",
        json={"page_id": source["id"], "file": file["file"], "name": file["name"]},
    )
    source = client.get("/api/v1/pages/Media test").json()
    ops = client.app.state.fileops
    original_write = ops._write_body_sync

    def fail_source(rel, body, base_hash, actor):
        if rel == source["path"]:
            raise OSError("Disk full")
        return original_write(rel, body, base_hash, actor)

    monkeypatch.setattr(ops, "_write_body_sync", fail_source)
    with pytest.raises(OSError, match="Disk full"):
        client.post(
            "/api/v1/media/move",
            json={
                "source_id": source["id"],
                "target_path": target["path"],
                "file": file["file"],
                "block": source["body"],
                "base_hash": source["hash"],
            },
        )
    assert client.get("/api/v1/pages/Media test").json()["body"] == source["body"]
    assert client.get("/api/v1/pages/Rollback destination").json()["body"] == target["body"]
