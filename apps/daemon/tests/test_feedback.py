from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from graite.app import create_app
from graite.config import Settings
from tests.conftest import TOKEN


def test_feedback_is_off_without_an_endpoint(client: TestClient) -> None:
    assert client.get("/api/v1/feedback").json() == {"enabled": False}
    r = client.post("/api/v1/feedback", json={"message": "hi"})
    assert r.status_code == 503


@pytest.fixture
def posts(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    """Route the daemon's outgoing feedback call to an in-process handler."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(500 if b"fail" in request.content else 200)

    real = httpx.AsyncClient

    def client(*args: object, **kwargs: object) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr("graite.api.feedback.httpx.AsyncClient", client)
    return seen


@pytest.fixture
def online(settings: Settings, tmp_path: Path) -> Iterator[TestClient]:
    settings.feedback_url = "https://feedback.example/api"
    logs = settings.app_dir / "logs"
    logs.mkdir(parents=True)
    (logs / "daemon.log").write_text("\n".join(f"line {i}" for i in range(300)), encoding="utf-8")
    with TestClient(create_app(settings), headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        yield c


def test_feedback_posts_message_and_context(online: TestClient, posts: list[httpx.Request]) -> None:
    assert online.get("/api/v1/feedback").json() == {"enabled": True}
    r = online.post(
        "/api/v1/feedback",
        json={"kind": "bug", "message": " Menus stay open ", "email": "", "include_log": True},
    )
    assert r.status_code == 200 and r.json() == {"sent": True}, r.text
    assert str(posts[0].url) == "https://feedback.example/api"
    sent = json.loads(posts[0].content)
    assert sent["kind"] == "bug" and sent["message"] == "Menus stay open"
    assert sent["email"] is None and sent["version"]
    log = sent["log"].splitlines()
    assert len(log) == 200 and log[-1] == "line 299"

    online.post("/api/v1/feedback", json={"message": "no log"})
    assert json.loads(posts[1].content)["log"] is None


def test_feedback_reports_an_unreachable_service(
    online: TestClient, posts: list[httpx.Request]
) -> None:
    assert online.post("/api/v1/feedback", json={"message": "fail"}).status_code == 502
    assert online.post("/api/v1/feedback", json={"message": ""}).status_code == 422
