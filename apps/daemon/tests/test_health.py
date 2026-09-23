from __future__ import annotations

from fastapi.testclient import TestClient

from graite.config import Settings
from tests.conftest import TOKEN


def test_health_ok(client: TestClient, settings: Settings) -> None:
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["index"]["vec_version"].startswith("v")
    assert (settings.graite_dir / "index.sqlite").exists()


def test_missing_token_is_401(client: TestClient) -> None:
    r = client.get("/api/v1/health", headers={"Authorization": ""})
    assert r.status_code == 401


def test_wrong_token_is_401(client: TestClient) -> None:
    r = client.get("/api/v1/health", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_health_reports_a_new_vault_until_it_holds_pages(
    client: TestClient, settings: Settings
) -> None:
    first = client.get("/api/v1/health").json()
    assert first["is_new"] is True and first["pages"] == 0 and first["vault_name"] == "vault"
    client.post("/api/v1/pages", json={"title": "Projects"})
    again = client.get("/api/v1/health").json()
    assert again["is_new"] is False and again["pages"] == 1
    # Reopening the same folder: the index exists, so it is no longer new.
    from graite.app import create_app

    with TestClient(create_app(settings), headers={"Authorization": f"Bearer {TOKEN}"}) as reopened:
        assert reopened.get("/api/v1/health").json()["is_new"] is False
