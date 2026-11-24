"""The local copy of one account's mail: `.graite/mail/<account id>/mail.sqlite`.

Derivable state: deleting it only means the next sync fetches the mail again. Each call opens
its own connection, because the sync writes from a worker thread while the API reads.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from graite.mail.parse import Parsed, plain_subject, thread_id

# Raised when what is kept per mail changes (2: pictures inside the text are kept with it).
VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    name TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    uidvalidity INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    folder TEXT NOT NULL,
    uid INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    recipients TEXT NOT NULL,
    cc TEXT NOT NULL,
    date TEXT NOT NULL,
    seen INTEGER NOT NULL,
    flagged INTEGER NOT NULL,
    snippet TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_html TEXT NOT NULL,
    attachments TEXT NOT NULL,
    size INTEGER NOT NULL,
    partial INTEGER NOT NULL DEFAULT 0,
    UNIQUE (folder, uid)
);
CREATE TABLE IF NOT EXISTS message_refs (
    message_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    PRIMARY KEY (message_id, ref)
);
CREATE INDEX IF NOT EXISTS message_refs_ref ON message_refs (ref);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, date);
CREATE INDEX IF NOT EXISTS messages_message_id ON messages (message_id);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages (folder, date);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    subject, sender, body, content='messages', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, subject, sender, body)
    VALUES (new.id, new.subject, new.sender_name || ' ' || new.sender_email, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, subject, sender, body)
    VALUES ('delete', old.id, old.subject, old.sender_name || ' ' || old.sender_email,
            old.body_text);
END;
"""

_WORD = re.compile(r"[\w@.\-]+", re.UNICODE)


def match_query(text: str) -> str:
    """What the user typed as an FTS5 query: every word must occur, the last as a prefix."""
    words = [w.replace('"', "") for w in _WORD.findall(text)]
    words = [w for w in words if w.strip(".-")]
    if not words:
        return ""
    quoted = [f'"{w}"' for w in words]
    quoted[-1] += "*"
    return " ".join(quoted)


class MailBox:
    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.path = folder / "mail.sqlite"
        self._ready = False
        self._setup = threading.Lock()

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        self.folder.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            with self._setup:  # the sync's thread and an API read may both be first
                if not self._ready:
                    conn.execute("PRAGMA journal_mode=WAL")
                    if conn.execute("PRAGMA user_version").fetchone()[0] != VERSION:
                        # Kept in an older shape: drop it, the next sync fetches it again.
                        for table in ("messages_fts", "message_refs", "messages", "folders"):
                            conn.execute(f"DROP TABLE IF EXISTS {table}")
                        conn.execute(f"PRAGMA user_version = {VERSION}")
                    conn.executescript(SCHEMA)
                    self._ready = True
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ------------------------------------------------------------- written by the sync

    def set_folders(self, folders: list[tuple[str, str, str]]) -> None:
        """`(name, title, role)` of every folder that is kept; the others are dropped."""
        with self._db() as conn:
            names = [name for name, _, _ in folders]
            for (gone,) in conn.execute("SELECT name FROM folders").fetchall():
                if gone not in names:
                    conn.execute("DELETE FROM messages WHERE folder = ?", (gone,))
                    conn.execute("DELETE FROM folders WHERE name = ?", (gone,))
            self._prune(conn)
            for name, title, role in folders:
                conn.execute(
                    "INSERT INTO folders (name, title, role) VALUES (?, ?, ?) "
                    "ON CONFLICT (name) DO UPDATE SET title = excluded.title, role = excluded.role",
                    (name, title, role),
                )

    def open_folder(self, name: str, uidvalidity: int) -> set[int]:
        """The uids already kept. A changed validity means the server renumbered the
        folder, so what is kept no longer matches and is dropped."""
        with self._db() as conn:
            row = conn.execute("SELECT uidvalidity FROM folders WHERE name = ?", (name,)).fetchone()
            if row is not None and row[0] != uidvalidity:
                conn.execute("DELETE FROM messages WHERE folder = ?", (name,))
                self._prune(conn)
            conn.execute("UPDATE folders SET uidvalidity = ? WHERE name = ?", (uidvalidity, name))
            rows = conn.execute("SELECT uid FROM messages WHERE folder = ?", (name,)).fetchall()
            return {r[0] for r in rows}

    def close_folder(self, name: str) -> None:
        with self._db() as conn:
            conn.execute(
                "UPDATE folders SET synced_at = ? WHERE name = ?",
                (datetime.now(UTC).isoformat(), name),
            )

    def drop(self, folder: str, uids: set[int]) -> None:
        with self._db() as conn:
            conn.executemany(
                "DELETE FROM messages WHERE folder = ? AND uid = ?", [(folder, u) for u in uids]
            )
            self._prune(conn)

    @staticmethod
    def _prune(conn: sqlite3.Connection) -> None:
        conn.execute(
            "DELETE FROM message_refs WHERE message_id NOT IN (SELECT message_id FROM messages)"
        )

    def set_flags(self, folder: str, flags: dict[int, tuple[bool, bool]]) -> int:
        """`uid -> (seen, flagged)`; returns how many messages changed."""
        changed = 0
        with self._db() as conn:
            for uid, (seen, flagged) in flags.items():
                changed += conn.execute(
                    "UPDATE messages SET seen = ?, flagged = ? WHERE folder = ? AND uid = ? "
                    "AND (seen != ? OR flagged != ?)",
                    (seen, flagged, folder, uid, seen, flagged),
                ).rowcount
        return changed

    def add(
        self,
        folder: str,
        uid: int,
        parsed: Parsed,
        *,
        seen: bool,
        flagged: bool,
        size: int,
        received: datetime,
        partial: bool = False,
    ) -> None:
        with self._db() as conn:
            thread = self._thread(conn, parsed)
            conn.execute(
                "INSERT OR REPLACE INTO messages (folder, uid, message_id, thread_id, subject, "
                "sender_name, sender_email, recipients, cc, date, seen, flagged, snippet, "
                "body_text, body_html, attachments, size, partial) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    folder,
                    uid,
                    parsed.message_id,
                    thread,
                    parsed.subject,
                    parsed.sender.name,
                    parsed.sender.email,
                    json.dumps([p.as_dict() for p in parsed.to]),
                    json.dumps([p.as_dict() for p in parsed.cc]),
                    (parsed.date or received).astimezone(UTC).isoformat(),
                    seen,
                    flagged,
                    parsed.snippet,
                    parsed.text,
                    parsed.html,
                    json.dumps([a.as_dict() for a in parsed.attachments]),
                    size,
                    partial,
                ),
            )

    @staticmethod
    def _thread(conn: sqlite3.Connection, parsed: Parsed) -> str:
        """The conversation a mail belongs to. Mail arrives in any order (newest first, one
        folder after another), so a mail can link conversations that were apart until now:
        those become one."""
        known = [parsed.message_id, *parsed.references]
        marks = ",".join("?" * len(known))
        rows = conn.execute(
            f"SELECT DISTINCT thread_id FROM messages WHERE message_id IN ({marks}) "
            "OR message_id IN (SELECT message_id FROM message_refs "
            f"WHERE ref IN ({marks}))",
            known + known,
        ).fetchall()
        conn.executemany(
            "INSERT OR IGNORE INTO message_refs (message_id, ref) VALUES (?, ?)",
            [(parsed.message_id, ref) for ref in parsed.references],
        )
        threads = sorted(str(r[0]) for r in rows)
        if threads:
            for other in threads[1:]:
                conn.execute(
                    "UPDATE messages SET thread_id = ? WHERE thread_id = ?", (threads[0], other)
                )
            return threads[0]
        if (
            not parsed.references
            and plain_subject(parsed.subject) != parsed.subject.strip().lower()
        ):
            # A reply from a client that leaves the references out still joins the
            # conversation with the same subject; a first mail starts its own.
            candidates = conn.execute(
                "SELECT thread_id, subject FROM messages WHERE lower(subject) LIKE ? "
                "ORDER BY date DESC LIMIT 20",
                ("%" + plain_subject(parsed.subject),),
            ).fetchall()
            for candidate in candidates:
                if plain_subject(candidate[1]) == plain_subject(parsed.subject):
                    return str(candidate[0])
        return thread_id(parsed.thread_key)

    # ------------------------------------------------------------- read by the API

    def folders(self) -> list[dict[str, Any]]:
        with self._db() as conn:
            rows = conn.execute(
                "SELECT f.name, f.title, f.role, f.synced_at, "
                "(SELECT COUNT(*) FROM messages m WHERE m.folder = f.name AND m.seen = 0) unread, "
                "(SELECT COUNT(*) FROM messages m WHERE m.folder = f.name) total "
                "FROM folders f"
            ).fetchall()
        order = {"inbox": 0, "sent": 1, "archive": 2}
        found = [dict(r) for r in rows]
        found.sort(key=lambda f: (order.get(f["role"], 3), f["title"].lower()))
        return found

    def unread(self) -> int:
        with self._db() as conn:
            row = conn.execute(
                "SELECT COUNT(DISTINCT m.message_id) FROM messages m JOIN folders f "
                "ON f.name = m.folder WHERE f.role = 'inbox' AND m.seen = 0"
            ).fetchone()
        return int(row[0])

    def threads(
        self, *, folder: str = "", query: str = "", before: str = "", limit: int = 50
    ) -> list[dict[str, Any]]:
        """Conversations, newest first. In a folder: those with a mail in it. With a query:
        those with a matching mail anywhere in the account."""
        where, args = "1", []
        match = match_query(query)
        if match:
            where = "thread_id IN (SELECT m.thread_id FROM messages_fts f JOIN messages m "
            where += "ON m.id = f.rowid WHERE messages_fts MATCH ?)"
            args.append(match)
        elif folder:
            where = "thread_id IN (SELECT thread_id FROM messages WHERE folder = ?)"
            args.append(folder)
        having = "HAVING latest < ?" if before else ""
        if before:
            args.append(before)
        with self._db() as conn:
            # Subject, sender and preview come from the newest mail of each conversation,
            # looked up by itself: with several MAX() in one query SQLite picks any row.
            rows = conn.execute(
                "SELECT g.thread_id, g.latest, m.subject, m.sender_name, m.sender_email, "
                "m.snippet, g.count, g.unread, g.flagged, g.has_attachments FROM ("
                "SELECT thread_id, MAX(date) AS latest, COUNT(DISTINCT message_id) AS count, "
                "COUNT(DISTINCT CASE WHEN seen = 0 THEN message_id END) AS unread, "
                "MAX(flagged) AS flagged, MAX(attachments != '[]') AS has_attachments "
                f"FROM messages WHERE {where} GROUP BY thread_id {having} "
                "ORDER BY latest DESC LIMIT ?) g JOIN messages m ON m.id = ("
                "SELECT id FROM messages WHERE thread_id = g.thread_id "
                "ORDER BY date DESC, id DESC LIMIT 1) ORDER BY g.latest DESC",
                (*args, limit),
            ).fetchall()
            found = []
            for row in rows:
                thread = dict(row)
                people = conn.execute(
                    "SELECT sender_name, sender_email FROM messages WHERE thread_id = ? "
                    "GROUP BY sender_email ORDER BY MIN(date)",
                    (thread["thread_id"],),
                ).fetchall()
                thread["participants"] = [p[0] or p[1] for p in people]
                thread["date"] = thread.pop("latest")
                thread["flagged"] = bool(thread["flagged"])
                thread["has_attachments"] = bool(thread["has_attachments"])
                found.append(thread)
        return found

    def message(self, message: int) -> dict[str, Any] | None:
        """One kept mail with the ids it refers to, for writing a reply to it."""
        with self._db() as conn:
            row = conn.execute("SELECT * FROM messages WHERE id = ?", (message,)).fetchone()
            if row is None:
                return None
            refs = conn.execute(
                "SELECT ref FROM message_refs WHERE message_id = ?", (row["message_id"],)
            ).fetchall()
        found = dict(row)
        for key in ("recipients", "cc"):
            found[key] = json.loads(found[key])
        found["references"] = [r[0] for r in refs]
        return found

    def places(self, thread: str, role: str = "") -> dict[str, list[int]]:
        """`folder -> uids` of a conversation's mails; with `role`, only in that folder."""
        with self._db() as conn:
            rows = conn.execute(
                "SELECT m.folder, m.uid FROM messages m JOIN folders f ON f.name = m.folder "
                "WHERE m.thread_id = ? AND (? = '' OR f.role = ?)",
                (thread, role, role),
            ).fetchall()
        found: dict[str, list[int]] = {}
        for folder, uid in rows:
            found.setdefault(str(folder), []).append(int(uid))
        return found

    def mark_seen(self, places: dict[str, list[int]]) -> None:
        with self._db() as conn:
            for folder, uids in places.items():
                conn.executemany(
                    "UPDATE messages SET seen = 1 WHERE folder = ? AND uid = ?",
                    [(folder, uid) for uid in uids],
                )

    def unseen(self, thread: str) -> dict[str, list[int]]:
        """`folder -> uids` of a conversation's mails that are not read yet."""
        with self._db() as conn:
            rows = conn.execute(
                "SELECT folder, uid FROM messages WHERE thread_id = ? AND seen = 0", (thread,)
            ).fetchall()
        found: dict[str, list[int]] = {}
        for folder, uid in rows:
            found.setdefault(str(folder), []).append(int(uid))
        return found

    def sent_folder(self) -> str | None:
        with self._db() as conn:
            row = conn.execute("SELECT name FROM folders WHERE role = 'sent' LIMIT 1").fetchone()
        return str(row[0]) if row else None

    def location(self, message: int) -> tuple[str, int] | None:
        """`(folder, uid)` of a kept mail: where to fetch it whole from the server."""
        with self._db() as conn:
            row = conn.execute(
                "SELECT folder, uid FROM messages WHERE id = ?", (message,)
            ).fetchone()
        return (str(row[0]), int(row[1])) if row else None

    def thread(self, thread: str) -> list[dict[str, Any]]:
        """The mails of one conversation, oldest first. A mail that sits in several folders
        (a Gmail label, a copy in Sent) is shown once."""
        with self._db() as conn:
            rows = conn.execute(
                "SELECT m.*, f.title AS folder_title FROM messages m "
                "JOIN folders f ON f.name = m.folder WHERE m.thread_id = ? ORDER BY m.date, m.id",
                (thread,),
            ).fetchall()
        seen: dict[str, dict[str, Any]] = {}
        for row in rows:
            message = dict(row)
            first = seen.get(message["message_id"])
            if first is not None:
                first["folders"].append(message["folder_title"])
                continue
            message["folders"] = [message.pop("folder_title")]
            for key in ("recipients", "cc", "attachments"):
                message[key] = json.loads(message[key])
            for key in ("seen", "flagged", "partial"):
                message[key] = bool(message[key])
            seen[message["message_id"]] = message
        return list(seen.values())
