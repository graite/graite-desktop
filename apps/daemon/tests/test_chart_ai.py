"""Charts from words (D73): /charts/ai with a scripted model."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.config import Settings
from graite.tables import chart_ai
from tests.test_charts import setup


class FakeModel:
    """Answers each request with the next scripted reply and remembers what it was asked."""

    def __init__(self, *replies: str) -> None:
        self.replies = list(replies)
        self.asked: list[list[dict[str, Any]]] = []

    @asynccontextmanager
    async def use(self, config: Any = None) -> AsyncIterator[Any]:
        model = self

        class Provider:
            async def chat(
                self, messages: Any, tools: Any, **_: Any
            ) -> AsyncIterator[dict[str, str]]:
                model.asked.append(list(messages))
                yield {"content": model.replies.pop(0)}

        yield Provider()


def reply(spec: dict[str, Any], message: str = "Here it is.") -> str:
    return "```json\n" + json.dumps({"spec": spec, "message": message}) + "\n```"


@pytest.fixture
def model(client: TestClient, settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Any:
    setup(client, settings)
    monkeypatch.setattr(
        chart_ai, "load_config", lambda db: SimpleNamespace(provider="local", model="m")
    )
    fake = FakeModel()
    monkeypatch.setattr(client.app.state.models, "use", fake.use)  # type: ignore[attr-defined]
    return fake


def ask(client: TestClient, prompt: str, current: dict[str, Any] | None = None) -> Any:
    r = client.post(
        "/api/v1/charts/ai", json={"page_path": "Garage", "prompt": prompt, "current": current}
    )
    return r.json() if r.status_code == 200 else (r.status_code, r.json()["detail"])


def test_words_become_a_checked_chart(client: TestClient, model: FakeModel) -> None:
    model.replies.append(
        reply({"source": "cars", "x": "name", "y": "price", "sort": "y desc"}, "Price per car.")
    )
    out = ask(client, "price per car, highest first")
    assert out == {
        "spec": {"source": "cars", "x": "name", "y": "price", "sort": "y desc"},
        "message": "Price per car.",
    }
    # The model saw the tables (with their columns and samples) and the request as data.
    sent = json.loads(model.asked[0][1]["content"].split("\n", 1)[1])
    assert sent["request"] == "price per car, highest first"
    cars = next(t for t in sent["tables"] if t["name"] == "cars")
    assert {"name": "price", "type": "number"} in cars["columns"] and len(cars["sample"]) == 3


def test_a_change_sees_the_current_chart(client: TestClient, model: FakeModel) -> None:
    model.replies.append(reply({"source": "cars", "type": "line", "x": "month(bought)"}))
    current = {"source": "cars", "x": "brand", "palette": "ocean"}
    out = ask(client, "as a line per month", current)
    assert out["spec"]["type"] == "line"
    assert json.loads(model.asked[0][1]["content"].split("\n", 1)[1])["current_chart"] == current


def test_a_bad_chart_is_retried_then_refused_in_words(client: TestClient, model: FakeModel) -> None:
    model.replies += [
        reply({"source": "cars", "x": "colour"}),
        reply({"source": "cars", "x": "brand", "y": "sum(name)"}),
    ]
    status, detail = ask(client, "by colour")
    assert status == 400 and "Could not make that chart" in detail
    retry = model.asked[1][-1]["content"]
    assert "no column 'colour'" in retry  # the model was told what was wrong
    # A good second answer is accepted.
    model.replies += [reply({"sql": "SELECT 1"}), reply({"source": "cars", "x": "brand"})]
    assert ask(client, "by brand")["spec"] == {"source": "cars", "x": "brand"}
    assert "Do not use sql" in model.asked[3][-1]["content"]


def test_local_only_pages_refuse_cloud_models(
    client: TestClient, model: FakeModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        chart_ai, "load_config", lambda db: SimpleNamespace(provider="openrouter", model="m")
    )
    saved = client.put("/api/v1/pages/Garage/ai-settings", json={"values": {"cloud": "local-only"}})
    assert saved.status_code == 200, saved.text
    status, detail = ask(client, "anything")
    assert status == 400 and "local models only" in detail
    assert model.asked == []


def test_no_model_says_where_to_set_one_up(
    client: TestClient, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup(client, settings)

    class NoModel:
        @asynccontextmanager
        async def use(self, config: Any = None) -> AsyncIterator[Any]:
            raise ValueError("Choose a model in Settings → Chat first.")
            yield

    monkeypatch.setattr(
        chart_ai, "load_config", lambda db: SimpleNamespace(provider="local", model="")
    )
    monkeypatch.setattr(client.app.state.models, "use", NoModel().use)  # type: ignore[attr-defined]
    status, detail = ask(client, "anything")
    assert status == 400 and "Settings" in detail
