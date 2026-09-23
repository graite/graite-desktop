from __future__ import annotations

import json

from fastapi.testclient import TestClient

from tests.conftest import TOKEN


def test_events_roundtrip(client: TestClient) -> None:
    with client.websocket_connect(f"/events?token={TOKEN}") as ws:
        client.app.state.events.publish("hello", {"n": 1})  # type: ignore[attr-defined]
        message = json.loads(ws.receive_text())
    assert message == {"type": "hello", "data": {"n": 1}}


def test_events_rejects_bad_token(client: TestClient) -> None:
    import pytest
    from starlette.testclient import WebSocketDisconnect

    # The client fixture sends a valid Authorization header by default; blank it so the
    # query-string token is what gets checked.
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/events?token=nope", headers={"Authorization": ""}):
            pass
