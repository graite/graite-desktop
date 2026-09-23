"""Page events enqueue agent runs after editing settles; never execute in a file write."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from graite.jobs.queue import PRIORITY_SUMMARY

log = logging.getLogger(__name__)


def in_scope(path: str, scope: Any) -> bool:
    def under(roots: list[str]) -> bool:
        return any(path == r or path.startswith(r + "/") for r in roots)

    if under(scope.excluded):
        return False
    if scope.kind == "page":
        return path in scope.roots[:1]
    return (not scope.roots and scope.kind == "vault") or under(scope.roots)


class PageTriggers:
    def __init__(self, state: Any, delay: float = 3.0) -> None:
        self.state = state
        self.delay = delay
        self.task: asyncio.Task[None] | None = None
        self.pending: dict[tuple[str, str], asyncio.Task[None]] = {}
        self.ready = asyncio.Event()

    async def start(self) -> None:
        self.task = asyncio.create_task(self.listen(), name="agents:page-triggers")
        await self.ready.wait()

    async def stop(self) -> None:
        tasks = [*self.pending.values(), *([self.task] if self.task else [])]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.pending.clear()

    async def listen(self) -> None:
        async with self.state.events.subscribe() as queue:
            self.ready.set()
            while True:
                event = json.loads(await queue.get())
                try:
                    self.handle(event["type"], event.get("data", {}))
                except Exception:
                    log.exception("Page trigger event failed")

    def handle(self, kind: str, data: dict[str, Any]) -> None:
        if kind == "policy_changed":
            self.state.cron.sync()
            return
        if data.get("actor") not in ("ui", "user", "external"):
            return
        event = (
            "page_created"
            if kind == "tree_changed" and data.get("reason") == "create"
            else ("page_updated" if kind == "file_changed" else None)
        )
        path = data.get("path")
        if not event or not isinstance(path, str):
            return
        for agent in self.state.definitions.agents():
            if not in_scope(path, agent.scope):
                continue
            if not any(
                t["enabled"]
                and t["event"] == event
                and (path == t["path"] or path.startswith(t["path"] + "/"))
                for t in agent.triggers
            ):
                continue
            key = (agent.name, path)
            old = self.pending.pop(key, None)
            if old:
                old.cancel()
            self.pending[key] = asyncio.create_task(self.fire(agent.name, path, event))

    async def fire(self, name: str, path: str, event: str) -> None:
        try:
            await asyncio.sleep(self.delay)
            agent = self.state.definitions.agent(name)
            if not agent or not in_scope(path, agent.scope):
                return
            if not any(
                t["enabled"]
                and t["event"] == event
                and (path == t["path"] or path.startswith(t["path"] + "/"))
                for t in agent.triggers
            ):
                return
            self.state.queue.enqueue(
                "agent_run",
                {"agent": name, "trigger": event, "trigger_page": path},
                key=f"page-trigger:{name}:{path}",
                page_path=path,
                priority=PRIORITY_SUMMARY,
                max_attempts=1,
            )
        finally:
            key = (name, path)
            if self.pending.get(key) is asyncio.current_task():
                self.pending.pop(key, None)
