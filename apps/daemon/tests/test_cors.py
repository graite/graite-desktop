from __future__ import annotations

from fastapi.testclient import TestClient


def test_preflight_from_webview_is_allowed(client: TestClient) -> None:
    r = client.options(
        "/api/v1/health",
        headers={
            "Authorization": "",
            "Origin": "tauri://localhost",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization, content-type, x-graite-request",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "tauri://localhost"
    allowed = r.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed
    assert "content-type" in allowed
    assert "x-graite-request" in allowed


def test_get_from_webview_carries_cors_header(client: TestClient) -> None:
    r = client.get("/api/v1/health", headers={"Origin": "http://tauri.localhost"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://tauri.localhost"


def test_unknown_origin_gets_no_cors_header(client: TestClient) -> None:
    r = client.get("/api/v1/health", headers={"Origin": "https://evil.example"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers
