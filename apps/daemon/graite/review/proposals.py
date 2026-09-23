"""Proposals: model-made changes that wait for a decision, and the decisions themselves.

A proposal is a row, never a file. Accepting one re-reads the page: if it is unchanged the
patch applies; if the edited passage is still unique the change is rebased; otherwise the
proposal becomes a conflict. Every apply goes through fileops (snapshot, activity, event), so
a decision can be reverted like any other write.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import sqlite3
import uuid
from datetime import UTC, datetime
from typing import Any

from graite.events import EventBus
from graite.index.db import transaction
from graite.vault import frontmatter as fm
from graite.vault.blocks import check_fences, view_fields
from graite.vault.fileops import FileOps, append_markdown
from graite.vault.models import ConflictError
from graite.vault.paths import parent_of, slugify, validate_rel
from graite.vault.properties import PageProperty, from_compact, merge, merge_definitions

KINDS = ("edit", "append", "create", "delete", "move", "properties")


def _normalise(
    items: list[dict[str, Any]], existing: list[dict[str, Any]] | None
) -> list[dict[str, Any]]:
    """What the model wrote, as properties, keeping the ids and options already in use."""
    prior = [PageProperty.model_validate(p) for p in existing or []]
    return [field.model_dump() for field in from_compact(items, prior)]


STATUSES = (
    "pending",
    "accepted",
    "rejected",
    "conflict",
    "auto_applied",
    "superseded",
    "reverted",
    "refused",
)
ACTOR = "agent"


def now() -> str:
    return datetime.now(UTC).isoformat()


class ProposalConflict(Exception):
    def __init__(self, proposal: dict[str, Any], current_body: str | None) -> None:
        super().__init__("The page changed since this was proposed.")
        self.proposal = proposal
        self.current_body = current_body


def _patch(old: str, new: str, path: str) -> str:
    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )


def _body_hash(body: str) -> str:
    """Frontmatter changes on every save (`updated:`), so "rebased" is judged on the body."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _append(body: str, text: str) -> str:
    return append_markdown(body, text)


def _changed_since(proposal: dict[str, Any], doc: Any) -> bool:
    """Did the page body change since the proposal was made? Older rows only carry the file
    hash, which also moves when frontmatter is touched; use it as the fallback."""
    if proposal.get("base_body_hash"):
        return bool(_body_hash(doc.body) != proposal["base_body_hash"])
    return bool(doc.hash != proposal["base_hash"])


class Proposals:
    def __init__(self, db: sqlite3.Connection, ops: FileOps, events: EventBus) -> None:
        self.db = db
        self.ops = ops
        self.events = events

    # ----------------------------------------------------------------- rows

    @staticmethod
    def row_dict(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        data["edited"] = bool(data.get("edited"))
        data["reason_delivered"] = bool(data.get("reason_delivered"))
        return data

    def get(self, proposal_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM proposals WHERE id=?", (proposal_id,)).fetchone()
        return self.row_dict(row) if row else None

    def find(
        self,
        *,
        status: str | None = None,
        conversation_id: str | None = None,
        page_path: str | None = None,
        run_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        clauses, params = [], []
        if status:
            clauses.append("status=?")
            params.append(status)
        if conversation_id:
            clauses.append("conversation_id=?")
            params.append(conversation_id)
        if page_path:
            clauses.append("(page_path=? OR new_path=?)")
            params.extend([page_path, page_path])
        if run_id:
            clauses.append("run_id=?")
            params.append(run_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self.db.execute(
            f"SELECT * FROM proposals{where} ORDER BY created_at DESC LIMIT ?",
            (*params, max(1, min(limit, 500))),
        ).fetchall()
        return [self.row_dict(r) for r in rows]

    def _update(self, proposal_id: str, **fields: Any) -> dict[str, Any]:
        keys = ", ".join(f"{k}=?" for k in fields)
        with transaction(self.db):
            self.db.execute(
                f"UPDATE proposals SET {keys} WHERE id=?", (*fields.values(), proposal_id)
            )
        found = self.get(proposal_id)
        assert found is not None
        return found

    def _decided(self, proposal: dict[str, Any]) -> dict[str, Any]:
        self.events.publish("proposal_decided", proposal)
        return proposal

    def _pending_parent(
        self, path: str, conversation_id: str | None, run_id: str | None
    ) -> str | None:
        """A create this same turn filed for `path`, still waiting for the user."""
        column, value = (
            ("conversation_id", conversation_id) if conversation_id else ("run_id", run_id)
        )
        if not value:
            return None
        row = self.db.execute(
            f"SELECT id FROM proposals WHERE {column}=? AND kind='create' AND new_path=? "
            "AND status='pending' ORDER BY created_at DESC LIMIT 1",
            (value, path),
        ).fetchone()
        return str(row["id"]) if row else None

    def _applied_parent(self, parent_proposal_id: str) -> str:
        """Where the parent proposal actually landed, which may not be where it said it would:
        `create_page` renames a folder that collides with an existing one."""
        parent = self.get(parent_proposal_id)
        if parent is None:
            raise ValueError("The page this one belongs under is gone.")
        if parent["status"] == "pending":
            raise ValueError("Accept the page this one belongs under first.")
        if parent["status"] not in ("accepted", "auto_applied"):
            raise ValueError(
                f"The page this one belongs under was {parent['status'].replace('_', ' ')}."
            )
        return str(parent["new_path"] or parent["page_path"] or "")

    async def _board_fields(
        self, parent: str, conversation_id: str | None = None, run_id: str | None = None
    ) -> list[dict[str, Any]]:
        """The field definitions the parent's existing cards already agree on, if any.

        A new card inherits them, so it joins the board's real columns instead of inventing a
        near-miss set of options that would render as a second column of its own.
        """
        try:
            doc = await self.ops.read_page(parent)
            children = await self.ops.child_pages(doc.id)
        except (ValueError, FileNotFoundError, AttributeError):
            pending = self._pending_parent(parent, conversation_id, run_id)
            proposal = self.get(pending) if pending else None
            if proposal:
                return [f.model_dump() for f in view_fields(proposal["new_text"] or "")]
            return []
        cards = [
            view_fields(doc.body),
            *[
                [
                    PageProperty.model_validate(f)
                    for f in (child.frontmatter.get("properties") or [])
                ]
                for child in children
            ],
        ]
        return [field.model_dump() for field in merge_definitions(cards)]

    # ----------------------------------------------------------------- create

    async def create(
        self,
        kind: str,
        page_path: str,
        *,
        summary: str,
        policy: str,
        run_id: str | None = None,
        conversation_id: str | None = None,
        old_text: str | None = None,
        new_text: str | None = None,
        new_path: str | None = None,
        title: str | None = None,
        opt_in_source: str | None = None,
        properties: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if kind not in KINDS:
            raise ValueError("Unknown proposal kind.")
        # A new page at the vault root has no parent: the empty path is legitimate there.
        page_path = validate_rel(page_path) if (page_path or kind != "create") else ""
        base_hash: str | None = None
        base_body_hash: str | None = None
        page_id: str | None = None
        patch = ""
        page_title = title
        parent_proposal_id: str | None = None
        fields: list[dict[str, Any]] | None = None
        base_fields: list[dict[str, Any]] | None = None
        resulting: str | None = None
        if kind in ("edit", "append", "delete", "move", "properties"):
            doc = await self.ops.read_page(page_path)
            base_hash, page_id, page_title = doc.hash, doc.id or None, doc.title
            base_body_hash = _body_hash(doc.body)
            if kind == "edit":
                if not old_text or new_text is None:
                    raise ValueError("An edit needs the text to replace and its replacement.")
                if doc.body.count(old_text) != 1:
                    raise ValueError(
                        "The text to replace must occur exactly once on the page; quote more of it."
                    )
                resulting = doc.body.replace(old_text, new_text, 1)
                patch = _patch(doc.body, resulting, page_path)
            elif kind == "append":
                if not new_text or not new_text.strip():
                    raise ValueError("Nothing to append.")
                resulting = _append(doc.body, new_text)
                patch = _patch(doc.body, resulting, page_path)
            elif kind == "properties":
                if not properties:
                    raise ValueError("Give at least one property to set.")
                base_fields = list(doc.frontmatter.get("properties") or [])
                fields = _normalise(properties, base_fields)
            elif kind == "move":
                if new_path is None:
                    raise ValueError("A move needs a destination.")
                new_path = validate_rel(new_path) if new_path else ""
                if new_path:
                    try:
                        await self.ops.read_page(new_path)
                    except FileNotFoundError:
                        # Moving under a page this same turn proposed, as for create.
                        parent_proposal_id = self._pending_parent(new_path, conversation_id, run_id)
                        if parent_proposal_id is None:
                            raise
        else:  # create
            if not title or not title.strip():
                raise ValueError("A new page needs a title.")
            parent = page_path if page_path else None
            if parent:
                try:
                    await self.ops.read_page(parent)
                except FileNotFoundError:
                    # The parent may be a page this same turn proposed and the user has not
                    # accepted yet; without this an agent cannot file a board and its cards
                    # together, and would have to ask to be asked again.
                    parent_proposal_id = self._pending_parent(parent, conversation_id, run_id)
                    if parent_proposal_id is None:
                        raise
            page_title = title.strip()
            new_path = ((parent + "/") if parent else "") + slugify(page_title)
            resulting = (new_text or "").strip("\n") + "\n"
            patch = _patch("", resulting, new_path)
            if properties:
                if not parent:
                    raise ValueError("Properties are available on nested pages only.")
            if parent:
                definitions = await self._board_fields(parent, conversation_id, run_id)
                if definitions or properties:
                    # Definitions contain no card values. Merge the explicit values into
                    # them, so cards made by tools also inherit the empty board's fields.
                    prior = [PageProperty.model_validate(f) for f in definitions]
                    fields = [
                        f.model_dump() for f in merge(prior, from_compact(properties or [], prior))
                    ]
        # A fence the editor cannot parse renders as grey text, so the page would look nothing
        # like what was asked for and nobody would know why. Refuse it while it is still words.
        problem = check_fences(resulting) if resulting else None
        if problem:
            raise ValueError(problem)
        proposal_id = "p_" + uuid.uuid4().hex[:10]
        with transaction(self.db):
            self.db.execute(
                "INSERT INTO proposals (id, run_id, conversation_id, page_path, page_id, kind, "
                "base_hash, old_text, new_text, patch, summary, status, policy, created_at, "
                "page_title, new_path, base_body_hash, opt_in_source, properties_json, "
                "base_properties_json, parent_proposal_id) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    proposal_id,
                    run_id,
                    conversation_id,
                    page_path,
                    page_id,
                    kind,
                    base_hash,
                    old_text,
                    new_text,
                    patch,
                    summary.strip()[:500],
                    "pending",
                    policy,
                    now(),
                    page_title,
                    new_path,
                    base_body_hash,
                    opt_in_source,
                    json.dumps(fields) if fields is not None else None,
                    json.dumps(base_fields) if base_fields is not None else None,
                    parent_proposal_id,
                ),
            )
        proposal = self.get(proposal_id)
        assert proposal is not None
        self.events.publish("proposal", proposal)
        if policy == "auto_apply":
            proposal = await self.accept(proposal_id, decided_by="policy")
        return proposal

    # ----------------------------------------------------------------- decide

    async def accept(
        self, proposal_id: str, *, decided_by: str = "user", new_text: str | None = None
    ) -> dict[str, Any]:
        proposal = self.get(proposal_id)
        if proposal is None:
            raise KeyError(proposal_id)
        if proposal["status"] not in ("pending", "conflict"):
            raise ValueError(f"This proposal was already {proposal['status'].replace('_', ' ')}.")
        edited = new_text is not None and new_text != proposal["new_text"]
        if edited:
            proposal["new_text"] = new_text
        kind = proposal["kind"]
        applied_hash: str | None = None
        snapshot: str | None = None
        trash_id: str | None = None
        reason = proposal.get("reason")
        if kind in ("edit", "append"):
            doc = await self.ops.read_page(proposal["page_path"])
            if kind == "edit":
                old = proposal["old_text"] or ""
                if doc.body.count(old) != 1:
                    return self._conflict(proposal_id, doc.body)
                new_body = doc.body.replace(old, proposal["new_text"] or "", 1)
            else:
                new_body = _append(doc.body, proposal["new_text"] or "")
            if _changed_since(proposal, doc):
                reason = "rebased"
            snapshot = await self.ops.snapshot_page(proposal["page_path"])
            written = await self.ops.write_body(proposal["page_path"], new_body, doc.hash, ACTOR)
            applied_hash = written.hash
        elif kind == "create":
            parent = proposal["page_path"] or None
            if proposal.get("parent_proposal_id"):
                parent = self._applied_parent(proposal["parent_proposal_id"])
            created = await self.ops.create_page(
                parent, proposal["page_title"] or "Untitled", None, ACTOR
            )
            written = await self.ops.write_body(
                created.path, proposal["new_text"] or "", None, ACTOR
            )
            applied_hash = written.hash
            proposal["new_path"] = created.path
            if proposal.get("properties_json"):
                fields = json.loads(proposal["properties_json"])
                written = await self.ops.set_properties(created.id, fields, written.hash, ACTOR)
                applied_hash = written.hash
        elif kind == "properties":
            doc = await self.ops.read_page(proposal["page_path"])
            current = list(doc.frontmatter.get("properties") or [])
            if current != json.loads(proposal.get("base_properties_json") or "[]"):
                reason = "rebased"
            # Merge by name rather than replace: a field the user filled in by hand between
            # the proposal and the review is theirs, and must survive accepting this.
            fields = [
                field.model_dump()
                for field in merge(
                    [PageProperty.model_validate(f) for f in current],
                    [
                        PageProperty.model_validate(f)
                        for f in json.loads(proposal["properties_json"] or "[]")
                    ],
                )
            ]
            snapshot = await self.ops.snapshot_page(proposal["page_path"])
            written = await self.ops.set_properties(doc.id, fields, doc.hash, ACTOR)
            applied_hash = written.hash
            # Revert has to restore what was really there, not what was there at propose time.
            self._update(proposal_id, base_properties_json=json.dumps(current))
        elif kind == "delete":
            doc = await self.ops.read_page(proposal["page_path"])
            if _changed_since(proposal, doc):
                reason = "page changed after the proposal; deleted the current version"
            trash_id = await self.ops.trash_page(proposal["page_path"], ACTOR)
        elif kind == "move":
            doc = await self.ops.read_page(proposal["page_path"])
            target = proposal.get("new_path") or ""
            if proposal.get("parent_proposal_id"):
                target = self._applied_parent(proposal["parent_proposal_id"])
            target_doc = await self.ops.read_page(target) if target else None
            moved = await self.ops.relocate_page(
                doc.id, target_doc.id if target_doc else None, "inside"
            )
            proposal["new_path"] = moved.path
            snapshot = proposal["page_path"]  # remember where it came from for revert
        status = "auto_applied" if decided_by == "policy" else "accepted"
        updated = self._update(
            proposal_id,
            status=status,
            decided_by=decided_by,
            decided_at=now(),
            reason=reason,
            applied_hash=applied_hash,
            snapshot=snapshot,
            trash_id=trash_id,
            edited=int(edited or bool(proposal.get("edited"))),
            new_text=proposal["new_text"],
            new_path=proposal.get("new_path"),
        )
        return self._decided(updated)

    def _conflict(self, proposal_id: str, current_body: str) -> dict[str, Any]:
        updated = self._update(
            proposal_id, status="conflict", reason="the text to replace is no longer unique"
        )
        self._decided(updated)
        raise ProposalConflict(updated, current_body)

    async def reject(self, proposal_id: str, reason: str = "") -> dict[str, Any]:
        proposal = self.get(proposal_id)
        if proposal is None:
            raise KeyError(proposal_id)
        if proposal["status"] not in ("pending", "conflict"):
            raise ValueError(f"This proposal was already {proposal['status'].replace('_', ' ')}.")
        rejected = self._decided(
            self._update(
                proposal_id,
                status="rejected",
                decided_by="user",
                decided_at=now(),
                reason=reason.strip()[:1000] or None,
                reason_delivered=0,
            )
        )
        # Cards whose board was just turned down have nowhere to land; leaving them pending
        # would only offer the user buttons that can now do nothing but fail.
        for row in self.db.execute(
            "SELECT id FROM proposals WHERE parent_proposal_id=? AND status='pending'",
            (proposal_id,),
        ).fetchall():
            self._decided(
                self._update(
                    row["id"],
                    status="superseded",
                    decided_by="user",
                    decided_at=now(),
                    reason="the page this belongs under was rejected",
                )
            )
        return rejected

    async def accept_many(self, ids: list[str]) -> dict[str, Any]:
        """Apply in creation order; stop at the first conflict, skip what cannot apply."""
        rows = [p for p in (self.get(i) for i in ids) if p is not None]
        rows.sort(key=lambda p: p["created_at"])
        applied: list[str] = []
        for proposal in rows:
            try:
                await self.accept(proposal["id"])
            except ProposalConflict:
                return {"applied": applied, "stopped_at": proposal["id"]}
            except ConflictError:
                # Lost a write race with another editor: leave it pending and stop here.
                return {"applied": applied, "stopped_at": proposal["id"]}
            except (ValueError, FileNotFoundError):
                continue
            applied.append(proposal["id"])
        return {"applied": applied, "stopped_at": None}

    async def reject_many(self, ids: list[str], reason: str = "") -> dict[str, Any]:
        """Reject everything still open; unknown and already decided proposals are skipped."""
        rejected: list[str] = []
        for proposal_id in ids:
            try:
                await self.reject(proposal_id, reason)
            except (KeyError, ValueError):
                continue
            rejected.append(proposal_id)
        return {"rejected": rejected}

    async def revert(self, proposal_id: str) -> dict[str, Any]:
        proposal = self.get(proposal_id)
        if proposal is None:
            raise KeyError(proposal_id)
        if proposal["status"] not in ("accepted", "auto_applied"):
            raise ValueError("Only an applied proposal can be reverted.")
        kind = proposal["kind"]
        if kind in ("edit", "append"):
            if not proposal.get("snapshot"):
                raise ValueError("No snapshot was kept for this change.")
            text = await self.ops.read_snapshot(proposal["snapshot"])
            _, body = fm.split(text)
            await self.ops.write_body(proposal["page_path"], body, None, ACTOR)
        elif kind == "properties":
            doc = await self.ops.read_page(proposal["page_path"])
            before = json.loads(proposal.get("base_properties_json") or "[]")
            await self.ops.set_properties(doc.id, before, doc.hash, ACTOR)
        elif kind == "create":
            if proposal.get("new_path"):
                await self.ops.trash_page(proposal["new_path"], ACTOR)
        elif kind == "delete":
            if not proposal.get("trash_id"):
                raise ValueError("The trash entry of this page is unknown.")
            await self.ops.restore(proposal["trash_id"], ACTOR)
        elif kind == "move":
            moved = await self.ops.read_page(proposal["new_path"] or proposal["page_path"])
            origin_parent = parent_of(proposal["snapshot"] or proposal["page_path"])
            parent_doc = await self.ops.read_page(origin_parent) if origin_parent else None
            await self.ops.relocate_page(moved.id, parent_doc.id if parent_doc else None, "inside")
        return self._decided(self._update(proposal_id, status="reverted", decided_at=now()))

    # ----------------------------------------------------------------- feedback

    def undelivered_rejections(self, conversation_id: str) -> list[str]:
        """Reasons the user gave when rejecting this conversation's proposals, once each."""
        rows = self.db.execute(
            "SELECT id, page_path, summary, reason FROM proposals WHERE conversation_id=? "
            "AND status='rejected' AND reason IS NOT NULL AND reason_delivered=0 "
            "ORDER BY decided_at",
            (conversation_id,),
        ).fetchall()
        if not rows:
            return []
        with transaction(self.db):
            self.db.executemany(
                "UPDATE proposals SET reason_delivered=1 WHERE id=?", [(r["id"],) for r in rows]
            )
        return [f"{r['summary']} ({r['page_path']}): {r['reason']}" for r in rows]
