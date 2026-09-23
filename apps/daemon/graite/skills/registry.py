"""Explicitly scoped tool registry. No model-accessible mutations.

Tools come from `skills/tools.py`; the registry decides which are callable for one turn
(skill `allowed-tools` narrowing, tool groups), enforces the conversation's scope on every
path, and numbers tool results as sources so answers can cite them.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable
from typing import Any

from graite.retrieval.scope import ResolvedScope, Scope
from graite.retrieval.scope import resolve as resolve_scope
from graite.retrieval.search import Searcher
from graite.review.proposals import ProposalConflict
from graite.skills import tools as tool_module
from graite.skills.library import discover
from graite.vault.fileops import FileOps
from graite.vault.instructions import safe_file
from graite.vault.models import ConflictError
from graite.vault.paths import validate_rel

# A path the model copied in display form: "Profile (Jarvis/Profile)".
_DISPLAY_FORM = re.compile(r"^.*\(([^()]+)\)\s*$")

DEFAULT_GROUPS = frozenset({"read", "search", "meta"})
PROPOSE_GROUPS = frozenset({"read", "search", "meta", "propose"})
# Draft mode may only create new pages; Act mode gets every propose tool.
DRAFT_TOOLS = frozenset({"propose_create"})
# Chat in Ask mode may add things when asked (a page, an entry, a card, property values) but
# never rewrites, deletes or moves existing content. Every call is still a reviewed proposal.
ASK_TOOLS = frozenset({"propose_create", "propose_append", "propose_properties"})
# Chat modes whose propose group is narrowed to a subset; Act is not narrowed.
MODE_TOOLS: dict[str, frozenset[str]] = {"ask": ASK_TOOLS, "draft": DRAFT_TOOLS}


def groups_for(mode: str) -> frozenset[str]:
    """Agents and the assistant: an Ask-mode definition is report-only and never proposes."""
    return PROPOSE_GROUPS if mode in ("act", "draft") else DEFAULT_GROUPS


def chat_groups_for(mode: str) -> frozenset[str]:
    """Interactive chat: every mode can propose; `MODE_TOOLS` narrows which tools."""
    return PROPOSE_GROUPS if mode in ("ask", "act", "draft") else DEFAULT_GROUPS


def chat_tools(mode: str) -> set[str]:
    """The tool names a chat turn in `mode` exposes (before skill/scope narrowing)."""
    groups = chat_groups_for(mode)
    names = {t.name for t in tool_module.TOOLS.values() if t.group in groups}
    narrow = MODE_TOOLS.get(mode)
    if narrow is not None:
        names = {n for n in names if tool_module.TOOLS[n].group != "propose" or n in narrow}
    return names


class Registry:
    def __init__(
        self,
        ops: FileOps,
        scope: ResolvedScope | str,
        *,
        searcher: Searcher | None = None,
        groups: frozenset[str] | set[str] = DEFAULT_GROUPS,
    ) -> None:
        self.ops = ops
        if isinstance(scope, str):
            scope = resolve_scope(
                ops.db, ops.vault, Scope("folder", [validate_rel(scope)]), cloud_provider=False
            )
        self.scope = scope
        self.searcher = searcher or Searcher(ops.db, None)
        self.groups = set(groups)
        self.allowed = {t.name for t in tool_module.TOOLS.values() if t.group in self.groups}
        self.library: dict[str, dict[str, Any]] = {}
        self.result_limit = 6000
        # Set by the pipeline: registers a tool result as a numbered, citable source.
        self.on_source: Callable[[dict[str, Any]], int] | None = None
        # Set by the pipeline when the propose group is on: the review queue and this turn.
        self.proposals: Any | None = None
        self.state: Any | None = None  # the app state, for tools that enqueue work
        self.turn: dict[str, Any] = {}
        # Events a tool wants streamed to the client (drained after each tool call).
        self.pending_events: list[dict[str, Any]] = []
        # Paths the model got slightly wrong in this tool call, and what they resolved to.
        self.corrections: dict[str, str] = {}
        self._epoch = ops.epoch

    def refresh(self) -> None:
        """A tool may have created a page since this turn's scope was resolved."""
        if self._epoch != self.ops.epoch:
            self.scope = resolve_scope(
                self.ops.db,
                self.ops.vault,
                self.scope.scope,
                cloud_provider=bool(self.turn.get("cloud_model")),
            )
            self._epoch = self.ops.epoch

    def create_parent(self, path: str) -> str:
        """Allow a pending parent from this conversation, only beneath an allowed page."""
        self.refresh()
        if not path:
            if self.scope.scope.kind != "vault" or self.scope.scope.roots:
                raise ValueError("Choose a parent page inside this conversation's scope.")
            return ""
        if self.scope.contains(path):
            return self.scoped(path)
        if self.proposals is not None:
            path = validate_rel(path)
            proposal_id = self.proposals._pending_parent(
                path, self.turn.get("conversation_id"), self.turn.get("run_id")
            )
            if proposal_id:
                proposal = self.proposals.get(proposal_id)
                self.create_parent(proposal["page_path"])
                safe_file(self.ops.vault, path + "/page.md")
                return path
        return self.scoped(path)

    def parallel_safe(self, name: str) -> bool:
        # Searcher has per-search mutable state; skill loading changes tool permissions.
        # Writes, searches and meta tools are barriers between independent reads.
        return name in {"read_page", "list_children"} and name in self.allowed

    def narrow(self, names: frozenset[str] | set[str], *, group: str) -> None:
        """Keep only `names` from one group (Draft mode: create pages, nothing else)."""
        self.allowed = {
            n for n in self.allowed if tool_module.TOOLS[n].group != group or n in names
        }

    async def load_library(self, allowlist: list[str] | None = None) -> None:
        root = self.scope.scope.roots[0] if self.scope.scope.roots else None
        self.library = await asyncio.to_thread(discover, self.ops.vault.resolve(), root, allowlist)

    def schemas(self) -> list[dict[str, Any]]:
        return [
            t.schema
            for t in tool_module.TOOLS.values()
            if t.name in self.allowed and t.group in self.groups
        ]

    def skill_index(self) -> str:
        return "\n".join(
            f"- {name}: {skill['description']}" for name, skill in self.library.items()
        )

    def scoped(self, path: str) -> str:
        self.refresh()
        raw = str(path).strip()
        if not self.scope.contains(raw):
            found = self._correct(raw)
            if found is None:
                raise ValueError(self._not_found(raw))
            self.corrections[raw] = found
            raw = found
        path = validate_rel(raw)
        safe_file(self.ops.vault, path + "/page.md")
        return path

    def _correct(self, raw: str) -> str | None:
        """The one page in scope the model most likely meant, or None when it is unclear.

        Small models join sibling names from the page tree ("Graite/Welcome/Todos"), copy
        the display form ("Profile (Jarvis/Profile)"), or get the case wrong. A unique match
        is used; anything ambiguous is left to the model with suggestions."""
        paths = [p for p in self.scope.paths if self.scope.contains(p)]
        display = _DISPLAY_FORM.match(raw)
        if display and self.scope.contains(display.group(1).strip().strip("/")):
            return display.group(1).strip().strip("/")
        wanted = raw.strip().strip("/")
        if not wanted:
            return None
        lower = wanted.lower()
        same = [p for p in paths if p.lower() == lower]
        if len(same) == 1:
            return same[0]
        segments = [s for s in lower.split("/") if s]
        for start in range(len(segments)):
            suffix = "/".join(segments[start:])
            matches = [p for p in paths if p.lower() == suffix or p.lower().endswith("/" + suffix)]
            if len(matches) == 1:
                return matches[0]
            if matches:
                return None
        last = segments[-1] if segments else lower
        titled = [p for p in paths if self.scope.titles.get(p, "").lower() == last]
        return titled[0] if len(titled) == 1 else None

    def _not_found(self, raw: str) -> str:
        if raw.strip().strip("/") in self.scope.excluded_local_only:
            return f"The page '{raw}' is local-only; a cloud model cannot use it."
        last = raw.strip().strip("/").rpartition("/")[2].lower()
        close = [
            p
            for p in self.scope.paths
            if last
            and (
                p.rpartition("/")[2].lower() == last
                or self.scope.titles.get(p, "").lower() == last
                or last in p.rpartition("/")[2].lower()
            )
        ][:3]
        hint = f" Did you mean: {', '.join(close)}?" if close else ""
        return (
            f"There is no page '{raw}' in this conversation's scope. Use the exact path from "
            f"the page tree or list_children.{hint}"
        )

    def paths(self) -> list[dict[str, str]]:
        self.refresh()
        return [{"path": p, "title": self.scope.titles.get(p, p)} for p in self.scope.paths]

    def note_source(self, *, result: dict[str, Any], **source: Any) -> None:
        if self.on_source is not None:
            result["source"] = self.on_source(source)

    async def invoke(self, name: str, arguments: str) -> str:
        try:
            tool = tool_module.TOOLS.get(name)
            if tool is None or name not in self.allowed or tool.group not in self.groups:
                raise ValueError("This tool is unavailable for the active skill.")
            args = json.loads(arguments) if arguments.strip() else {}
            if not isinstance(args, dict):
                raise ValueError("Tool arguments must be an object.")
            self.corrections = {}
            result = await tool.fn(self, **args)
            if self.corrections:
                note = "; ".join(f"'{a}' is '{b}'" for a, b in self.corrections.items())
                note = f"Used the closest page path: {note}. Use exact paths next time."
                if isinstance(result, dict):
                    result = {**result, "path_note": note}
                else:
                    result = {"path_note": note, "result": result}
            return json.dumps(result, ensure_ascii=False)
        except (ValueError, KeyError, TypeError, OSError) as exc:
            return json.dumps({"error": str(exc) or exc.__class__.__name__})
        except ProposalConflict as exc:
            # An auto-applied proposal lost a race with an edit: report, do not end the turn.
            return json.dumps(
                {
                    "error": f"Proposal {exc.proposal['id']} could not be applied: "
                    f"{exc.proposal.get('reason') or 'the page changed'}. It awaits review.",
                    "proposal_id": exc.proposal["id"],
                    "status": exc.proposal["status"],
                }
            )
        except ConflictError:
            return json.dumps({"error": "The page changed while applying; try again."})
