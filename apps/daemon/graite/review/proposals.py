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

from graite.dashboards import paths as dash_paths
from graite.events import EventBus
from graite.index.db import transaction
from graite.tables import paths as table_paths
from graite.tables import schema as tbl_schema
from graite.tables.edit import ColumnOp, RowOp, TableConflict
from graite.vault import frontmatter as fm
from graite.vault.blocks import check_fences, view_fields
from graite.vault.fileops import FileOps, append_markdown
from graite.vault.models import ConflictError
from graite.vault.paths import parent_of, slugify, validate_rel
from graite.vault.properties import PageProperty, from_compact, merge, merge_definitions

KINDS = ("edit", "append", "create", "delete", "move", "properties", "rows", "dashboard", "table")
# The field types a proposal may give a database field. Relations, formulas, files and page
# links need choices the table's own menus ask for.
FIELD_TYPES = (
    "text",
    "number",
    "currency",
    "percent",
    "single_select",
    "multi_select",
    "status",
    "date",
    "checkbox",
    "url",
    "email",
)


def _field(raw: Any) -> dict[str, Any]:
    """A database field as the model wrote it: a name, a type and, for selects, options."""
    if isinstance(raw, str):
        raw = {"name": raw}
    if not isinstance(raw, dict):
        raise ValueError("Each field is an object with a name and a type.")
    name = str(raw.get("name") or "").strip()
    if not name:
        raise ValueError("Each field needs a name.")
    if name.lower() == "id":
        raise ValueError("Every database has its own id field; leave `id` out.")
    kind = tbl_schema.normalize_type(raw.get("type") or "text")
    if kind == "relation":
        # A link to rows of another database: `table` is that database's path.
        target = str(raw.get("table") or raw.get("target") or "").strip()
        if not target:
            raise ValueError(
                f"Relation field {name!r} needs `table`: the path of the database it links to."
            )
        cardinality = str(raw.get("cardinality") or "one").strip().lower()
        if cardinality not in ("one", "many"):
            raise ValueError("cardinality must be one or many.")
        linked: dict[str, Any] = {
            "name": name,
            "type": "relation",
            "table": table_paths.parse(target).rel,
            "cardinality": cardinality,
        }
        reverse = str(raw.get("reverse") or "").strip()
        if reverse:
            linked["reverse"] = reverse
        return linked
    if kind not in FIELD_TYPES:
        raise ValueError(
            f"Field {name!r}: type must be one of {', '.join(FIELD_TYPES)} or relation. "
            "Formulas, files and page links are set up from the table's field menu."
        )
    options = raw.get("options") or []
    if isinstance(options, str):
        options = [o for o in tbl_schema.split_multi(options) if o]
    out: dict[str, Any] = {"name": name, "type": kind}
    if kind in tbl_schema.CHOICES and options:
        out["options"] = list(dict.fromkeys(str(o).strip() for o in options if str(o).strip()))
    return out


def _spec(field: dict[str, Any]) -> dict[str, Any]:
    """A field's entry in the schema file."""
    return {k: field[k] for k in ("type", "options") if k in field}


def _cell(value: Any) -> str:
    """A value as it is written in a CSV cell."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return tbl_schema.join_multi([str(v) for v in value])
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _describe_field(field: dict[str, Any]) -> str:
    if field["type"] == "relation":
        many = "several rows" if field.get("cardinality") == "many" else "one row"
        back = f", shown there as {field['reverse']}" if field.get("reverse") else ""
        target = table_paths.parse(field["table"])
        return f"{field['name']} (link to {many} of {target.name} on {target.page}{back})"
    options = f": {', '.join(field['options'])}" if field.get("options") else ""
    return f"{field['name']} ({field['type'].replace('_', ' ')}{options})"


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


def _row_op(raw: dict[str, Any]) -> dict[str, Any]:
    """A stored or model-written row op as `RowOp` fields."""
    op = str(raw.get("op") or "")
    if op not in ("insert", "update", "delete"):
        raise ValueError("Each row change is an insert, update or delete.")
    values = raw.get("values") or {}
    if not isinstance(values, dict):
        raise ValueError("values must map column names to values.")
    row_id = raw.get("id")
    if op != "insert" and not row_id:
        raise ValueError(f"A row {op} needs the row's id (from read_tables or run_query_ro).")
    base = raw.get("base")
    return {
        "op": op,
        "id": str(row_id) if row_id else None,
        "values": dict(values),
        "base": dict(base) if isinstance(base, dict) else None,
        "after": str(raw["after"]) if raw.get("after") else None,
        "first": bool(raw.get("first")),
    }


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
        if data.get("kind") == "rows" and data.get("payload_json"):
            # Row changes, readable by clients (chat receives these rows as they are).
            payload = json.loads(data["payload_json"])
            data["rows"] = {
                "table": payload.get("table"),
                "ops": payload.get("ops") or [],
                "columns": payload.get("columns"),
                "applied": "revert" in payload,
            }
        if data.get("kind") == "table" and data.get("payload_json"):
            # A new database, or changes to a database's fields.
            payload = json.loads(data["payload_json"])
            data["table"] = {
                "action": payload.get("action"),
                "table": payload.get("created") or payload.get("table"),
                "name": payload.get("name"),
                "fields": payload.get("fields"),
                "ops": payload.get("ops"),
                "row_count": len(payload.get("rows") or []),
                "applied": "revert" in payload or "created" in payload,
            }
        if data.get("kind") == "dashboard" and data.get("payload_json"):
            # A dashboard file (D72): the proposed HTML is new_text, the file before old_text.
            payload = json.loads(data["payload_json"])
            data["dashboard"] = {
                "src": payload.get("src"),
                "file": payload.get("file"),
                "show": bool(payload.get("show")),
                "created": payload.get("created", data.get("old_text") is None),
                "html": data.get("new_text"),
            }
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
        except ValueError, FileNotFoundError, AttributeError:
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
        rows: dict[str, Any] | None = None,
        dashboard: dict[str, Any] | None = None,
        fields_change: dict[str, Any] | None = None,
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
        payload: dict[str, Any] | None = None
        if kind == "rows":
            # Row edits to a table in `page_path`'s `_data/`; the page is where they are
            # reviewed. `base_hash` is the table file's, and each op carries the values it saw.
            if not rows or not rows.get("ops"):
                raise ValueError("Give at least one row change.")
            table = table_paths.parse(str(rows.get("table") or ""))
            if table.page != page_path:
                raise ValueError("The table must belong to the page the proposal is filed on.")
            doc = await self.ops.read_page(page_path)
            page_id, page_title = doc.id or None, doc.title
            ops = [RowOp(**_row_op(o)) for o in rows["ops"]]
            try:
                prepared, base_hash, columns = await self.ops.prepare_table_rows(table.rel, ops)
                payload = {"table": table.rel, "ops": prepared, "columns": columns}
            except ValueError as exc:
                # Values for fields this conversation has proposed but the user has not
                # accepted yet: file the rows behind that proposal, so one review covers
                # both and nobody has to ask twice. They are checked when they apply.
                waiting, gained = self._pending_fields(table.rel, conversation_id, run_id)
                state = await self.ops.table_state(table.rel, [])
                known = {*state["header"], *state["kinds"], *gained}
                used = {name for op in ops for name in op.values}
                if "no column" not in str(exc).lower() or waiting is None or not used <= known:
                    raise
                parent_proposal_id = waiting
                payload = {
                    "table": table.rel,
                    "ops": [_row_op(o) for o in rows["ops"]],
                    "columns": None,
                    "deferred": True,
                }
            new_path = table.rel
        elif kind == "table":
            doc = await self.ops.read_page(page_path)
            page_id, page_title = doc.id or None, doc.title
            payload, new_text = await self._prepare_table(page_path, fields_change or {})
            new_path = payload.get("table")
        elif kind == "dashboard":
            # An HTML file in `page_path`'s `_dashboards/` (D72). old_text is the file as it
            # was (None: new), so accepting refuses a file changed meanwhile.
            if not dashboard or not str(dashboard.get("html") or "").strip():
                raise ValueError("A dashboard needs its HTML.")
            target = dash_paths.parse(page_path, str(dashboard.get("src") or ""))
            doc = await self.ops.read_page(page_path)
            page_id, page_title = doc.id or None, doc.title
            old_text = await self.ops.read_dashboard(target.page, target.src)
            new_text = str(dashboard["html"])
            if len(new_text.encode("utf-8")) > dash_paths.MAX_BYTES:
                raise ValueError("A dashboard can be at most 1 MB of HTML.")
            if old_text == new_text:
                raise ValueError("The dashboard already has exactly this HTML.")
            show = bool(dashboard.get("show", True)) and target.src not in doc.body
            payload = {"src": target.src, "file": target.rel, "show": show}
            patch = _patch(old_text or "", new_text, target.rel)
            new_path = target.rel
        elif kind in ("edit", "append", "delete", "move", "properties"):
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
                "base_properties_json, parent_proposal_id, payload_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
                    json.dumps(payload, ensure_ascii=False) if payload is not None else None,
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
            if parent:
                snapshot = await self._link_child(parent, created.path)
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
        elif kind == "rows":
            applied_hash = await self._apply_rows(proposal, decided_by)
        elif kind == "table":
            snapshot = await self._apply_table(proposal)
        elif kind == "dashboard":
            snapshot = await self._apply_dashboard(proposal)
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

    async def _link_child(self, parent: str, child: str) -> str | None:
        """Put a link to a new page on its parent, as "/page" in the editor does, so the page
        is reachable from where it belongs and not only from the sidebar. A parent that
        shows its subpages in a view (a board, table or list) already shows it. Returns the
        parent's snapshot when it was changed."""
        try:
            doc = await self.ops.read_page(parent)
        except FileNotFoundError:
            return None
        name = child.rpartition("/")[2]
        if "```graite:view" in doc.body or view_fields(doc.body):
            return None
        if f"[[{name}]]" in doc.body or f"[[{child}]]" in doc.body:
            return None
        snapshot = await self.ops.snapshot_page(parent)
        try:
            await self.ops.write_body(parent, _append(doc.body, f"[[{name}]]\n"), doc.hash, ACTOR)
        except ConflictError:
            return None  # the parent is being edited: the page exists, the link can wait
        return snapshot

    async def _apply_dashboard(self, proposal: dict[str, Any]) -> str | None:
        """Write the dashboard file; when asked, show it on its page (returns that page's
        snapshot, so a revert removes the block again)."""
        payload = json.loads(proposal.get("payload_json") or "{}")
        page, src = proposal["page_path"], payload["src"]
        try:
            await self.ops.write_dashboard(
                page, src, proposal["new_text"] or "", ACTOR, base=proposal.get("old_text")
            )
        except ValueError as exc:
            updated = self._update(proposal["id"], status="conflict", reason=str(exc))
            self._decided(updated)
            raise ProposalConflict(updated, "") from exc
        if not payload.get("show"):
            return None
        doc = await self.ops.read_page(page)
        if src in doc.body:
            return None
        snapshot = await self.ops.snapshot_page(page)
        fence = f"```graite:dashboard\nsrc: {src}\n```\n"
        await self.ops.write_body(page, _append(doc.body, fence), doc.hash, ACTOR)
        return snapshot

    async def _prepare_table(
        self, page_path: str, change: dict[str, Any]
    ) -> tuple[dict[str, Any], str]:
        """Check a new database or a change to a database's fields without writing anything.
        Returns what to store and the words a reviewer reads."""
        action = str(change.get("action") or "")
        if action == "create":
            name = table_paths.check_name(str(change.get("name") or ""))
            fields = [_field(f) for f in change.get("fields") or []]
            if not fields:
                raise ValueError("A database needs at least one field.")
            names = [f["name"] for f in fields]
            if len({n.lower() for n in names}) != len(names):
                raise ValueError("Field names must be unique.")
            rows: list[dict[str, Any]] = []
            for row in change.get("rows") or []:
                if not isinstance(row, dict):
                    raise ValueError("Each row maps field names to values.")
                unknown = [k for k in row if k not in names]
                if unknown:
                    raise ValueError(
                        f"Rows use fields that are not in `fields`: {', '.join(unknown)}. "
                        f"The fields are: {', '.join(names)}."
                    )
                rows.append({k: _cell(v) for k, v in row.items()})
            for f in fields:
                if f["type"] == "relation":
                    await self.ops.table_state(f["table"], [])  # the target must exist
            payload = {
                "action": "create",
                "name": name,
                "fields": fields,
                "rows": rows,
                "show": bool(change.get("show", True)),
            }
            lines = [f"New database: {name}", "", "Fields:"]
            lines += [f"- {_describe_field(f)}" for f in fields]
            if rows:
                lines += ["", f"Rows: {len(rows)}"]
                first = names[0]
                lines += [f"- {r.get(first) or '(empty)'}" for r in rows[:12]]
                if len(rows) > 12:
                    lines.append(f"- … {len(rows) - 12} more")
            return payload, "\n".join(lines) + "\n"
        if action != "columns":
            raise ValueError("A table proposal creates a database or changes its fields.")
        target = table_paths.parse(str(change.get("table") or ""))
        if target.page != page_path:
            raise ValueError("The table must belong to the page the proposal is filed on.")
        raw_ops = change.get("ops") or []
        if not raw_ops:
            raise ValueError("Give at least one field change.")
        state = await self.ops.table_state(target.rel, [])
        header: list[str] = list(state["header"])
        kinds: dict[str, str] = dict(state["kinds"])
        virtual = [n for n in kinds if n not in header]

        def known(name: str) -> str:
            if name in header or name in virtual:
                return name
            match = [n for n in [*header, *virtual] if n.lower() == name.lower()]
            if len(match) == 1:
                return match[0]
            raise ValueError(
                f"The table has no field {name!r}. Its fields are: "
                f"{', '.join(n for n in header if n.lower() != 'id')}."
            )

        ops: list[dict[str, Any]] = []
        lines = [f"Fields of {target.name}", ""]
        for raw in raw_ops:
            if not isinstance(raw, dict):
                raise ValueError("Each field change is an object with an op and a name.")
            op = str(raw.get("op") or "").strip().lower()
            op = {"remove": "delete", "set_type": "set", "set_options": "set", "retype": "set"}.get(
                op, op
            )
            if op == "add":
                field = _field(raw)
                if field["name"].lower() in (n.lower() for n in [*header, *virtual]):
                    raise ValueError(f"The table already has a field {field['name']!r}.")
                if field["type"] == "relation":
                    await self.ops.table_state(field["table"], [])  # the target must exist
                header.append(field["name"])
                ops.append({"op": "add", **field})
                lines.append(f"- Add {_describe_field(field)}")
                continue
            name = known(str(raw.get("name") or "").strip())
            if name.lower() == "id":
                raise ValueError("The id field cannot be changed.")
            if op == "rename":
                to = str(raw.get("to") or "").strip()
                if not to or to.lower() in (n.lower() for n in [*header, *virtual] if n != name):
                    raise ValueError(f"Choose a new, unused name for {name!r} (not {to!r}).")
                if name in header:
                    header[header.index(name)] = to
                ops.append({"op": "rename", "name": name, "to": to})
                lines.append(f"- Rename {name} to {to}")
            elif op == "delete":
                if name in header:
                    header.remove(name)
                ops.append({"op": "delete", "name": name})
                lines.append(f"- Remove {name} and its values")
            elif op == "move":
                index = raw.get("index")
                if not isinstance(index, int) or isinstance(index, bool):
                    raise ValueError("A move needs `index`: the field's new position from 0.")
                ops.append({"op": "move", "name": name, "index": index})
                lines.append(f"- Move {name} to position {index + 1}")
            elif op == "set":
                field = _field({**raw, "name": name, "type": raw.get("type") or kinds.get(name)})
                if field["type"] == "relation":
                    await self.ops.table_state(field["table"], [])  # the target must exist
                ops.append({"op": "set", **field})
                lines.append(f"- Change {_describe_field(field)}")
            else:
                raise ValueError("A field change is add, rename, delete, move or set.")
        payload = {"action": "columns", "table": target.rel, "ops": ops}
        return payload, "\n".join(lines) + "\n"

    async def _apply_table(self, proposal: dict[str, Any]) -> str | None:
        """Create the database, or change its fields one by one, keeping how to undo each.
        Returns the page's snapshot when the page itself was changed to show the database."""
        payload = json.loads(proposal.get("payload_json") or "{}")
        page = proposal["page_path"]
        snapshot: str | None = None
        try:
            if payload["action"] == "create":
                fields: list[dict[str, Any]] = payload["fields"]
                names = [f["name"] for f in fields]
                cells = [[row.get(n, "") for n in names] for row in payload.get("rows") or []]
                rel = await self.ops.create_table(
                    page, payload["name"], names, ACTOR, rows=cells or None
                )
                payload["created"] = rel
                self._update(proposal["id"], payload_json=json.dumps(payload, ensure_ascii=False))
                specs = {
                    f["name"]: _spec(f) for f in fields if f["type"] not in ("text", "relation")
                }
                if specs:
                    await self.ops.update_table_schema(rel, {"columns": specs}, ACTOR)
                for f in fields:
                    if f["type"] == "relation":
                        await self._link(rel, f)
                proposal["new_path"] = rel
                source = "_data/" + rel.rpartition("/")[2]
                doc = await self.ops.read_page(page)
                if payload.get("show") and source not in doc.body:
                    snapshot = await self.ops.snapshot_page(page)
                    fence = f"```graite:table\nsource: {source}\n```\n"
                    await self.ops.write_body(page, _append(doc.body, fence), doc.hash, ACTOR)
                return snapshot
            rel = payload["table"]
            revert: list[dict[str, Any]] = []
            try:
                for op in payload["ops"]:
                    name = op["name"]
                    before = (await self.ops.table_state(rel, [name]))["columns"][name]
                    if op["op"] == "add" and op["type"] == "relation":
                        await self._link(rel, op)
                        revert.append({"op": "delete", "name": name})
                    elif op["op"] == "add":
                        await self.ops.alter_table_columns(
                            rel, [ColumnOp("add", name)], None, ACTOR
                        )
                        if op["type"] != "text":
                            await self.ops.update_table_schema(
                                rel, {"columns": {name: _spec(op)}}, ACTOR
                            )
                        revert.append({"op": "delete", "name": name})
                    elif op["op"] == "rename":
                        await self.ops.alter_table_columns(
                            rel, [ColumnOp("rename", name, to=op["to"])], None, ACTOR
                        )
                        revert.append({"op": "rename", "name": op["to"], "to": name})
                    elif op["op"] == "delete":
                        await self.ops.alter_table_columns(
                            rel, [ColumnOp("delete", name)], None, ACTOR
                        )
                        revert.append({"op": "restore", "name": name, **before})
                    elif op["op"] == "move":
                        await self.ops.alter_table_columns(
                            rel, [ColumnOp("move", name, index=op["index"])], None, ACTOR
                        )
                        if "index" in before:
                            revert.append({"op": "move", "name": name, "index": before["index"]})
                    else:
                        if op["type"] == "relation":
                            await self._link(rel, op)
                        else:
                            await self.ops.update_table_schema(
                                rel, {"columns": {name: _spec(op)}}, ACTOR
                            )
                        revert.append({"op": "spec", "name": name, "spec": before.get("spec")})
            finally:
                # Whatever was applied can be undone, also when a later step failed.
                payload["revert"] = list(reversed(revert))
                self._update(proposal["id"], payload_json=json.dumps(payload, ensure_ascii=False))
        except (ValueError, FileNotFoundError, TableConflict) as exc:
            reason = str(exc) or "the table changed since the proposal"
            updated = self._update(proposal["id"], status="conflict", reason=reason)
            self._decided(updated)
            raise ProposalConflict(updated, "") from exc
        return None

    async def _link(self, rel: str, field: dict[str, Any]) -> None:
        """Make `field` of the table a relation to another database (adding it if needed)."""
        await self.ops.add_relation(
            rel,
            field["name"],
            field["table"],
            field.get("cardinality") or "one",
            field.get("reverse"),
            ACTOR,
        )

    def _pending_fields(
        self, table: str, conversation_id: str | None, run_id: str | None
    ) -> tuple[str | None, set[str]]:
        """Field changes to `table` this conversation proposed that still wait for a
        decision: the newest such proposal and the field names the table gains with them."""
        column, value = (
            ("conversation_id", conversation_id) if conversation_id else ("run_id", run_id)
        )
        if not value:
            return None, set()
        rows = self.db.execute(
            f"SELECT id, payload_json FROM proposals WHERE {column}=? AND kind='table' "
            "AND status='pending' AND new_path=? ORDER BY created_at",
            (value, table),
        ).fetchall()
        gained: set[str] = set()
        last: str | None = None
        for row in rows:
            payload = json.loads(row["payload_json"] or "{}")
            if payload.get("action") != "columns":
                continue
            last = str(row["id"])
            for op in payload.get("ops") or []:
                if op["op"] == "add":
                    gained.add(op["name"])
                elif op["op"] == "rename":
                    gained.add(op["to"])
        return last, gained

    async def _revert_table(self, proposal: dict[str, Any]) -> None:
        payload = json.loads(proposal.get("payload_json") or "{}")
        if payload.get("action") == "create":
            if payload.get("created"):
                await self.ops.remove_table(payload["created"], ACTOR)
            if proposal.get("snapshot"):
                text = await self.ops.read_snapshot(proposal["snapshot"])
                _, body = fm.split(text)
                await self.ops.write_body(proposal["page_path"], body, None, ACTOR)
            return
        rel = payload["table"]
        for op in payload.get("revert") or []:
            name = op["name"]
            if op["op"] in ("delete", "rename", "move"):
                await self.ops.alter_table_columns(
                    rel,
                    [ColumnOp(op["op"], name, to=op.get("to"), index=op.get("index"))],
                    None,
                    ACTOR,
                )
                continue
            if op["op"] == "restore" and "index" in op:
                await self.ops.alter_table_columns(
                    rel, [ColumnOp("add", name, index=op["index"])], None, ACTOR
                )
            # Replace the field's schema entry with the one it had (none: remove it).
            await self.ops.update_table_schema(rel, {"columns": {name: None}}, ACTOR)
            if op.get("spec"):
                await self.ops.update_table_schema(rel, {"columns": {name: op["spec"]}}, ACTOR)
            values: dict[str, str] = op.get("values") or {}
            if op["op"] == "restore" and values:
                present = await self.ops.read_table_rows(rel, list(values))
                await self.ops.write_table_rows(
                    rel,
                    [RowOp("update", i, {name: values[i]}) for i in values if i in present],
                    None,
                    ACTOR,
                )

    async def _apply_rows(self, proposal: dict[str, Any], decided_by: str = "user") -> str:
        """Write a rows proposal; keep the inverse ops so it can be reverted."""
        payload = json.loads(proposal.get("payload_json") or "{}")
        table, ops = payload["table"], payload["ops"]
        if payload.get("deferred"):
            # Rows filed behind a field change: that change goes first, then the rows are
            # checked against the table as it now is.
            parent = self.get(proposal.get("parent_proposal_id") or "")
            if parent is not None and parent["status"] in ("pending", "conflict"):
                parent = await self.accept(parent["id"], decided_by=decided_by)
            if parent is None or parent["status"] not in ("accepted", "auto_applied"):
                raise ValueError("The fields these rows need were not added.")
            try:
                ops, _, columns = await self.ops.prepare_table_rows(
                    table, [RowOp(**_row_op(o)) for o in ops]
                )
            except ValueError as exc:
                updated = self._update(proposal["id"], status="conflict", reason=str(exc))
                self._decided(updated)
                raise ProposalConflict(updated, "") from exc
            payload.update(ops=ops, columns=columns)
            payload.pop("deferred")
        before = await self.ops.read_table_rows(
            table, [o["id"] for o in ops if o.get("id") and o["op"] != "insert"]
        )
        try:
            result = await self.ops.write_table_rows(
                table, [RowOp(**_row_op(o)) for o in ops], None, ACTOR
            )
        except TableConflict as exc:
            changed = ", ".join(sorted({c.id for c in exc.conflicts}))
            updated = self._update(
                proposal["id"],
                status="conflict",
                reason=f"rows changed or removed since the proposal: {changed}",
            )
            self._decided(updated)
            raise ProposalConflict(updated, "") from exc
        revert: list[dict[str, Any]] = []
        for op, row_id in zip(ops, result["ids"], strict=True):
            if op["op"] == "insert":
                revert.append({"op": "delete", "id": row_id, "values": {}})
            elif op["op"] == "update":
                # Temporary ids (`@3`) become real ones when the write adds the id column.
                was = (before.get(op["id"]) or before.get(row_id) or {}).get("values", {})
                revert.append(
                    {
                        "op": "update",
                        "id": row_id,
                        "values": {k: was.get(k) for k in op["values"]},
                        "base": dict(op["values"]),
                    }
                )
            else:
                row = before.get(op["id"], {})
                revert.append(
                    {
                        "op": "insert",
                        "id": op["id"],
                        "values": row.get("values", op.get("base") or {}),
                        "after": row.get("after"),
                        "first": op["id"] in before and not row.get("after"),
                    }
                )
        # Undo in reverse order, so rows come back where they were.
        payload["revert"] = list(reversed(revert))
        self._update(proposal["id"], payload_json=json.dumps(payload, ensure_ascii=False))
        return str(result["hash"])

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
            except ConflictError, TableConflict:
                # Lost a write race with another editor: leave it pending and stop here.
                return {"applied": applied, "stopped_at": proposal["id"]}
            except ValueError, FileNotFoundError:
                continue
            applied.append(proposal["id"])
        return {"applied": applied, "stopped_at": None}

    async def reject_many(self, ids: list[str], reason: str = "") -> dict[str, Any]:
        """Reject everything still open; unknown and already decided proposals are skipped."""
        rejected: list[str] = []
        for proposal_id in ids:
            try:
                await self.reject(proposal_id, reason)
            except KeyError, ValueError:
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
                # `snapshot` set: accepting also put a link on the parent; take it out again.
                await self.ops.trash_page(
                    proposal["new_path"], ACTOR, unlink=bool(proposal.get("snapshot"))
                )
        elif kind == "delete":
            if not proposal.get("trash_id"):
                raise ValueError("The trash entry of this page is unknown.")
            await self.ops.restore(proposal["trash_id"], ACTOR)
        elif kind == "move":
            moved = await self.ops.read_page(proposal["new_path"] or proposal["page_path"])
            origin_parent = parent_of(proposal["snapshot"] or proposal["page_path"])
            parent_doc = await self.ops.read_page(origin_parent) if origin_parent else None
            await self.ops.relocate_page(moved.id, parent_doc.id if parent_doc else None, "inside")
        elif kind == "dashboard":
            payload = json.loads(proposal.get("payload_json") or "{}")
            page, src = proposal["page_path"], payload["src"]
            if proposal.get("old_text") is None:
                await self.ops.remove_dashboard(page, src, ACTOR)
            else:
                await self.ops.write_dashboard(page, src, proposal["old_text"], ACTOR)
            if proposal.get("snapshot"):
                text = await self.ops.read_snapshot(proposal["snapshot"])
                _, body = fm.split(text)
                await self.ops.write_body(page, body, None, ACTOR)
        elif kind == "table":
            await self._revert_table(proposal)
        elif kind == "rows":
            payload = json.loads(proposal.get("payload_json") or "{}")
            try:
                await self.ops.write_table_rows(
                    payload["table"],
                    [RowOp(**_row_op(o)) for o in payload.get("revert") or []],
                    None,
                    ACTOR,
                )
            except TableConflict as exc:
                raise ValueError(
                    "These rows were changed after the proposal was applied; "
                    "undo them by hand or edit the table."
                ) from exc
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
