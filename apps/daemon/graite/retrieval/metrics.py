"""What one chat turn cost: how long retrieval took, how much context went to the model,
how long until the first word and how fast the answer came (D100).

The numbers come from three places: timers in the pipeline, the sizes of what was put in the
prompt, and the usage the model server reports (`Provider.metrics`). They are streamed as a
`metrics` event, stored with the answer and on the run, and read by `scripts/bench_ask.py`.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any


def estimate_tokens(text: str) -> int:
    """Roughly how many tokens `text` is: four characters to a token.

    An estimate on purpose. It needs no tokenizer and no model, so it is the same number for
    every provider and can be compared from one run to the next; the real prompt and answer
    sizes are taken from what the model server reports.
    """
    return (len(text) + 3) // 4


@dataclass
class TurnMetrics:
    # Finding context before the model is asked: search, section building, first reads.
    retrieval_ms: int = 0
    # Distinct pages and passages given to the model at the start of the turn.
    pages: int = 0
    chunks: int = 0
    # Retrieved context in tokens (estimated): the passages in the prompt plus everything
    # tools returned during the turn.
    context_tokens: int = 0
    # What the model server counted, summed over the turn's requests. `cached_tokens` is the
    # part of the prompt it did not have to process again.
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    # Time the model server spent reading the prompt before it could answer (llama-server
    # reports it; None elsewhere). On a local model this is most of the wait.
    prompt_ms: int | None = None
    # From the start of the turn to the first word of the answer, and to the end.
    first_token_ms: int | None = None
    total_ms: int = 0
    tokens_per_second: float | None = None
    model_calls: int = 0
    tool_calls: int = 0
    # Each search of the turn: {"query", "hits", "ms"}.
    searches: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class TurnTimer:
    """Collects a turn's metrics as the pipeline goes."""

    def __init__(self) -> None:
        self.metrics = TurnMetrics()
        self._started = time.monotonic()
        self._first_token: float | None = None
        self._last_token: float | None = None
        self._generating = 0.0  # seconds between a request's first and last token
        self._request_first: float | None = None
        self._rates: list[float] = []
        self._tools: dict[str, float] = {}

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self._started) * 1000)

    def retrieved(self, since: float, sources: list[Any]) -> None:
        self.metrics.retrieval_ms += int((time.monotonic() - since) * 1000)
        self.metrics.chunks = len(sources)
        self.metrics.pages = len({s.page_path for s in sources if s.page_path})
        self.metrics.context_tokens += sum(estimate_tokens(s.prompt_block()) for s in sources)

    def token(self) -> None:
        now = time.monotonic()
        if self._first_token is None:
            self._first_token = now
            self.metrics.first_token_ms = int((now - self._started) * 1000)
        if self._request_first is None:
            self._request_first = now
        self._last_token = now

    def tool_started(self, call_id: str) -> None:
        self._tools[call_id] = time.monotonic()
        self.metrics.tool_calls += 1

    def tool_finished(self, call_id: str, name: str, arguments: dict[str, Any], result: Any) -> int:
        """Record a finished tool call; returns how long it took in milliseconds."""
        ms = int((time.monotonic() - self._tools.pop(call_id, time.monotonic())) * 1000)
        text = result if isinstance(result, str) else _text(result)
        self.metrics.context_tokens += estimate_tokens(text)
        if name == "search_vault":
            self.metrics.searches.append(
                {"query": str(arguments.get("query") or "")[:200], "hits": hits(result), "ms": ms}
            )
        return ms

    def searched(self, query: str, found: int, since: float) -> None:
        """The search the pipeline runs itself, before the model is asked."""
        self.metrics.searches.append(
            {"query": query[:200], "hits": found, "ms": int((time.monotonic() - since) * 1000)}
        )

    def request_done(self, usage: dict[str, Any]) -> None:
        """One model request ended: take what the server reported about it."""
        if not usage and self._request_first is None:
            return
        m = self.metrics
        m.model_calls += 1
        m.prompt_tokens += int(
            usage.get("prompt_tokens") or usage.get("prompt_n") or usage.get("input_tokens") or 0
        )
        m.completion_tokens += int(
            usage.get("completion_tokens")
            or usage.get("predicted_n")
            or usage.get("output_tokens")
            or 0
        )
        details = usage.get("prompt_tokens_details")
        m.cached_tokens += int(
            usage.get("cache_n")
            or usage.get("cache_read_input_tokens")
            or (details.get("cached_tokens") if isinstance(details, dict) else 0)
            or 0
        )
        reading = usage.get("prompt_ms")
        if isinstance(reading, (int, float)):
            m.prompt_ms = int((m.prompt_ms or 0) + reading)
        rate = usage.get("predicted_per_second")
        if isinstance(rate, (int, float)) and rate > 0:
            self._rates.append(float(rate))
        if self._request_first is not None and self._last_token is not None:
            self._generating += self._last_token - self._request_first
        self._request_first = None

    def finish(self) -> TurnMetrics:
        m = self.metrics
        m.total_ms = self.elapsed_ms()
        if self._rates:
            # llama-server measures generation itself; the last request is the answer.
            m.tokens_per_second = round(self._rates[-1], 1)
        elif m.completion_tokens and self._generating > 0.05:
            m.tokens_per_second = round(m.completion_tokens / self._generating, 1)
        return m


def _text(result: Any) -> str:
    import json

    try:
        return json.dumps(result, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(result)


def hits(result: Any) -> int:
    """How many results a `search_vault` call returned."""
    if isinstance(result, dict):
        return len(result.get("passages") or result.get("results") or []) + len(
            result.get("rows") or []
        )
    return len(result) if isinstance(result, list) else 0
