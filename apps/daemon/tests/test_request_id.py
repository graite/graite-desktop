from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def _capture(client: TestClient) -> list[tuple[str, dict[str, Any]]]:
    seen: list[tuple[str, dict[str, Any]]] = []
    bus = client.app.state.events  # type: ignore[attr-defined]
    original = bus.publish

    def record(type_: str, data: dict[str, Any] | None = None) -> None:
        seen.append((type_, data or {}))
        original(type_, data)

    bus.publish = record  # type: ignore[method-assign]
    return seen


def test_events_echo_the_request_id(client: TestClient) -> None:
    seen = _capture(client)
    r = client.post("/api/v1/pages", json={"title": "Echo"}, headers={"X-Graite-Request": "req-1"})
    assert r.status_code == 201
    r = client.put(
        "/api/v1/pages/Echo",
        json={"body": "hi\n", "base_hash": None},
        headers={"X-Graite-Request": "req-2"},
    )
    assert r.status_code == 200
    kinds = {(t, d.get("request_id")) for t, d in seen}
    assert ("tree_changed", "req-1") in kinds
    assert ("file_changed", "req-2") in kinds


def test_events_without_header_have_no_request_id(client: TestClient) -> None:
    seen = _capture(client)
    client.post("/api/v1/pages", json={"title": "Plain"})
    assert all(d.get("request_id") is None for _, d in seen)
