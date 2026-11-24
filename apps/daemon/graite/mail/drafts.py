"""Mail the user is still writing (`~/.graite/mail-drafts.json`).

A draft is the user's own writing, not a copy of something on the mail server, so it does not
live under the vault's `.graite/` (which may be deleted at any time): it sits with the
accounts. Drafts are not on the mail server; they exist in Graite until sent or discarded.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field

BODY_CHARS = 400_000


class Draft(BaseModel):
    id: str
    account_id: str
    to: str = Field(default="", max_length=4000)
    cc: str = Field(default="", max_length=4000)
    bcc: str = Field(default="", max_length=4000)
    subject: str = Field(default="", max_length=998)
    body: str = Field(default="", max_length=BODY_CHARS)
    # Set for a reply: the mail it answers and the conversation it belongs to.
    in_reply_to: str = ""
    references: list[str] = Field(default_factory=list)
    thread_id: str = ""
    created_at: str
    updated_at: str


class DraftsFile(BaseModel):
    version: int = 1
    drafts: list[Draft] = Field(default_factory=list)


def _now() -> str:
    return datetime.now(UTC).isoformat()


class DraftStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _load(self) -> DraftsFile:
        try:
            return DraftsFile.model_validate(json.loads(self.path.read_text(encoding="utf-8")))
        except OSError, ValueError:
            return DraftsFile()

    def _save(self, data: DraftsFile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp-{os.getpid()}")
        tmp.write_text(
            json.dumps(data.model_dump(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        os.replace(tmp, self.path)

    def list(self, account_id: str) -> list[Draft]:
        found = [d for d in self._load().drafts if d.account_id == account_id]
        return sorted(found, key=lambda d: d.updated_at, reverse=True)

    def get(self, account_id: str, draft_id: str) -> Draft | None:
        return next(
            (d for d in self._load().drafts if d.id == draft_id and d.account_id == account_id),
            None,
        )

    def create(self, account_id: str, **fields: object) -> Draft:
        data = self._load()
        now = _now()
        draft = Draft.model_validate(
            {
                **fields,
                "id": "md_" + uuid.uuid4().hex[:10],
                "account_id": account_id,
                "created_at": now,
                "updated_at": now,
            }
        )
        data.drafts.append(draft)
        self._save(data)
        return draft

    def update(self, account_id: str, draft_id: str, **fields: object) -> Draft | None:
        data = self._load()
        for index, draft in enumerate(data.drafts):
            if draft.id == draft_id and draft.account_id == account_id:
                changed = Draft.model_validate(
                    {**draft.model_dump(), **fields, "updated_at": _now()}
                )
                data.drafts[index] = changed
                self._save(data)
                return changed
        return None

    def remove(self, account_id: str, draft_id: str) -> bool:
        data = self._load()
        kept = [d for d in data.drafts if not (d.id == draft_id and d.account_id == account_id)]
        if len(kept) == len(data.drafts):
            return False
        data.drafts = kept
        self._save(data)
        return True

    def remove_account(self, account_id: str) -> None:
        data = self._load()
        data.drafts = [d for d in data.drafts if d.account_id != account_id]
        self._save(data)
