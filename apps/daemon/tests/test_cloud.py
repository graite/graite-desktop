from __future__ import annotations

import asyncio
import base64
import hashlib
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from graite.cloud.session import CALLBACK_PATH, CloudSession, Tokens, get_cloud, set_cloud
from graite.config import Settings
from graite.models.config import AIConfig
from graite.models.providers import Provider

USAGE = {
    "plan": {"id": "free", "name": "Free", "max_output_tokens": 4096},
    "today": {
        "limit": 100_000,
        "used": 38_000,
        "reserved": 0,
        "remaining": 62_000,
        "percent_used": 38,
        "resets_at": "2026-09-25T00:00:00Z",
    },
    "email": "ada@example.com",
    "email_verified": False,
    "verify_by": "2026-09-27T12:00:00Z",
}


class FakeCloud:
    """Stands in for api.getgraite.com."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.challenge = ""
        self.revoked: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/auth/desktop/token":
            form = parse_qs(request.content.decode())
            grant = form["grant_type"][0]
            if grant == "authorization_code":
                verifier = form["code_verifier"][0]
                digest = hashlib.sha256(verifier.encode()).digest()
                expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
                if form["code"] != ["good-code"] or expected != self.challenge:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return self.tokens("at-1", "rt-1")
            if form["refresh_token"] == ["rt-1"]:
                return self.tokens("at-2", "rt-2")
            return httpx.Response(400, json={"error": "invalid_grant"})
        if path == "/auth/desktop/revoke":
            self.revoked.append(parse_qs(request.content.decode())["token"][0])
            return httpx.Response(200, json={})
        if not request.headers.get("authorization", "").startswith("Bearer at-"):
            return httpx.Response(401, json={"error": {"code": "invalid_token"}})
        if path == "/api/v1/usage":
            return httpx.Response(200, json=USAGE)
        if path == "/v1/models":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "graite/fast",
                            "name": "Fast",
                            "context_length": 128000,
                            "graite": {"available": True, "min_plan": None},
                        },
                        {
                            "id": "graite/smart",
                            "name": "Smart",
                            "context_length": 200000,
                            "graite": {"available": False, "min_plan": "plus"},
                        },
                    ]
                },
            )
        return httpx.Response(404)

    @staticmethod
    def tokens(access: str, refresh: str, expires_in: int = 3600) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "access_token": access,
                "token_type": "Bearer",
                "expires_in": expires_in,
                "refresh_token": refresh,
                "scope": "inference account",
                "user": {"id": "u1", "email": "ada@example.com"},
            },
        )


@pytest.fixture
def keychain(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    store: dict[str, str] = {}
    monkeypatch.setattr("keyring.get_password", lambda service, name: store.get(name))
    monkeypatch.setattr(
        "keyring.set_password", lambda service, name, value: store.update({name: value})
    )
    monkeypatch.setattr("keyring.delete_password", lambda service, name: store.pop(name))
    return store


@pytest.fixture
def cloud(client: TestClient, settings: Settings, keychain: dict[str, str]) -> FakeCloud:
    fake = FakeCloud()
    set_cloud(
        CloudSession(
            "https://cloud.test", settings.app_dir, transport=httpx.MockTransport(fake.handler)
        )
    )
    return fake


@pytest.fixture
def opened(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    urls: list[str] = []
    monkeypatch.setattr("webbrowser.open", lambda url: urls.append(url) or True)
    return urls


def sign_in(client: TestClient, fake: FakeCloud, opened: list[str]) -> dict[str, list[str]]:
    started = client.post("/api/v1/cloud/login", json={}).json()
    assert started["opened"] is True and opened == [started["url"]]
    query = parse_qs(urlsplit(started["url"]).query)
    fake.challenge = query["code_challenge"][0]
    anonymous = TestClient(client.app)  # the browser: no bearer token
    page = anonymous.get(CALLBACK_PATH, params={"state": query["state"][0], "code": "good-code"})
    assert page.status_code == 200, page.text
    assert "You’re signed in" in page.text
    return query


def test_sign_in_uses_pkce_and_the_loopback_callback(
    client: TestClient, cloud: FakeCloud, opened: list[str], keychain: dict[str, str]
) -> None:
    query = sign_in(client, cloud, opened)
    assert query["client_id"] == ["graite-desktop"]
    assert query["code_challenge_method"] == ["S256"]
    redirect = urlsplit(query["redirect_uri"][0])
    assert (redirect.hostname, redirect.path) == ("127.0.0.1", CALLBACK_PATH)
    assert query["install_id"][0] and query["device_name"][0]
    # Tokens only in the keychain, never in files under the app dir.
    [stored] = keychain.values()
    assert "at-1" in stored and "rt-1" in stored

    status = client.get("/api/v1/cloud/status").json()
    assert status["signed_in"] is True
    assert status["email"] == "ada@example.com" and status["plan"] == "Free"
    assert status["plan_id"] == "free"
    assert status["today"]["percent_used"] == 38
    assert status["verify_by"] == "2026-09-27T12:00:00Z"


def test_sign_up_starts_at_create_an_account(
    client: TestClient, cloud: FakeCloud, opened: list[str]
) -> None:
    url = client.post("/api/v1/cloud/login", json={"signup": True}).json()["url"]
    parts = urlsplit(url)
    assert (parts.netloc, parts.path) == ("cloud.test", "/signup")
    assert parse_qs(parts.query)["next"][0].startswith("/auth/desktop/authorize?")


def test_the_callback_refuses_unknown_or_reused_state(
    client: TestClient, cloud: FakeCloud, opened: list[str], keychain: dict[str, str]
) -> None:
    anonymous = TestClient(client.app)
    forged = anonymous.get(CALLBACK_PATH, params={"state": "made-up", "code": "good-code"})
    assert forged.status_code == 400
    query = sign_in(client, cloud, opened)
    replay = anonymous.get(CALLBACK_PATH, params={"state": query["state"][0], "code": "good-code"})
    assert replay.status_code == 400  # single use
    cancelled = anonymous.get(CALLBACK_PATH, params={"state": "x", "error": "access_denied"})
    assert cancelled.status_code == 400 and "cancelled" in cancelled.text


def test_only_the_callback_skips_the_token(client: TestClient, cloud: FakeCloud) -> None:
    anonymous = TestClient(client.app)
    assert anonymous.get("/api/v1/cloud/status").status_code == 401
    assert anonymous.post("/api/v1/cloud/login", json={}).status_code == 401


def test_access_tokens_refresh_before_they_expire(
    client: TestClient, cloud: FakeCloud, keychain: dict[str, str]
) -> None:
    session = get_cloud()
    soon = Tokens(
        access_token="at-1",
        refresh_token="rt-1",
        expires_at=time.time() + 30,
        email="ada@example.com",
    )
    keychain[session._account()] = soon.model_dump_json()
    assert asyncio.run(session.access_token()) == "at-2"
    assert asyncio.run(session.access_token()) == "at-2"  # fresh now, no second refresh
    refreshes = [r for r in cloud.requests if r.url.path == "/auth/desktop/token"]
    assert len(refreshes) == 1


def test_a_refused_refresh_signs_out(
    client: TestClient, cloud: FakeCloud, keychain: dict[str, str]
) -> None:
    session = get_cloud()
    stale = Tokens(access_token="x", refresh_token="revoked", expires_at=0, email="a@b.c")
    keychain[session._account()] = stale.model_dump_json()
    assert asyncio.run(session.access_token()) is None
    assert keychain == {}
    assert client.get("/api/v1/cloud/status").json()["signed_in"] is False


def test_models_and_sign_out(
    client: TestClient, cloud: FakeCloud, opened: list[str], keychain: dict[str, str]
) -> None:
    assert client.get("/api/v1/cloud/models").status_code == 400  # signed out
    sign_in(client, cloud, opened)
    models = client.get("/api/v1/cloud/models").json()["models"]
    assert [(m["id"], m["available"], m["min_plan"]) for m in models] == [
        ("graite/fast", True, None),
        ("graite/smart", False, "plus"),
    ]
    assert client.post("/api/v1/cloud/logout").json() == {"signed_in": False}
    assert cloud.revoked == ["rt-1"]
    assert keychain == {}
    assert client.get("/api/v1/cloud/status").json()["signed_in"] is False


def test_chat_uses_the_cloud_token(client: TestClient, cloud: FakeCloud, opened: list[str]) -> None:
    config = AIConfig(provider="graite", model="graite/fast", base_url="https://cloud.test/v1")
    manager = client.app.state.models  # type: ignore[attr-defined]

    async def provider() -> Provider:
        async with manager.use(config) as found:
            return found  # type: ignore[no-any-return]

    with pytest.raises(ValueError, match="Sign in to Graite Cloud"):
        asyncio.run(provider())
    sign_in(client, cloud, opened)
    found = asyncio.run(provider())
    assert (found.kind, found.url, found.model) == (
        "graite",
        "https://cloud.test/v1",
        "graite/fast",
    )
    assert found.headers()["Authorization"] == "Bearer at-1"


def test_saving_graite_needs_no_connection(client: TestClient, cloud: FakeCloud) -> None:
    saved = client.put(
        "/api/v1/ai/config", json={"provider": "graite", "model": "graite/fast"}
    ).json()
    assert saved["provider"] == "graite"
    assert saved["base_url"] == "https://cloud.test/v1"
    assert saved["connection_id"] is None and saved["saved_model_id"] is None
    assert client.get("/api/v1/ai/connections").json()["connections"] == []


def test_graite_errors_reach_the_user_in_their_own_words() -> None:
    body: dict[str, Any] = {
        "error": {
            "code": "quota_exceeded",
            "type": "rate_limit_error",
            "message": "You've run out of free credits today. They reset at 00:00 UTC.",
        }
    }
    response = httpx.Response(429, json=body, request=httpx.Request("POST", "https://x/v1"))
    with pytest.raises(ValueError, match="run out of free credits today"):
        Provider.check(response)
    other = httpx.Response(
        429, json={"error": {"code": 429}}, request=httpx.Request("POST", "https://x/v1")
    )
    with pytest.raises(ValueError, match="busy or your usage limit"):
        Provider.check(other)


def test_the_access_log_never_shows_the_sign_in_code(client: TestClient) -> None:
    import logging

    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:1", "GET", f"{CALLBACK_PATH}?code=secret&state=s", "1.1", 200),
        None,
    )
    for f in logging.getLogger("uvicorn.access").filters:
        f.filter(record)  # type: ignore[union-attr]
    assert "secret" not in record.getMessage()
    assert CALLBACK_PATH in record.getMessage()
