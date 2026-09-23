"""What happens to a proposed change: propose it, apply it at once, or refuse it.

Resolved from the page's effective settings (`vault/policy.py`): `autonomy: none` refuses;
a cloud model may not touch a `local-only` page; `auto-apply` applies the listed kinds
without review, but only after the user opted that subtree in once. A move is never applied
automatically, and a delete only where `auto_apply_kinds` lists it explicitly — only the
assistant's memory root does (D57); the settings dialog never offers it.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Literal

from graite.vault.policy import Effective

Action = Literal["propose", "auto_apply", "refuse"]
NEVER_AUTO = ("move",)
OPT_IN_KEY = "auto_apply_opt_in"
NEEDS_OPT_IN = "auto_apply_needs_opt_in"


@dataclass
class Decision:
    action: Action
    reason: str
    policy: str  # stored on the proposal row: propose | auto_apply | auto_apply_needs_opt_in
    opt_in_source: str | None = None  # the folder/file whose autonomy setting needs opting in


def opted_in(db: sqlite3.Connection) -> set[str]:
    row = db.execute("SELECT value FROM meta WHERE key=?", (OPT_IN_KEY,)).fetchone()
    try:
        return set(json.loads(row[0])) if row else set()
    except ValueError:
        return set()


def opt_in(db: sqlite3.Connection, source: str) -> set[str]:
    current = opted_in(db)
    current.add(source)
    db.execute(
        "INSERT OR REPLACE INTO meta VALUES (?, ?)", (OPT_IN_KEY, json.dumps(sorted(current)))
    )
    return current


def decide(
    effective: Effective, kind: str, *, cloud_model: bool, opted: set[str] | None = None
) -> Decision:
    if effective.autonomy == "none":
        return Decision("refuse", "This page's AI settings don't allow changes by AI.", "refused")
    if cloud_model and not effective.cloud_allowed:
        return Decision(
            "refuse",
            "This page is local-only; propose changes to it with an on-device model.",
            "refused",
        )
    if effective.autonomy == "auto-apply" and kind not in NEVER_AUTO:
        kinds = effective.values.get("auto_apply_kinds") or []
        # Settings saved before properties could auto-apply list only edit; editing a page
        # already covers its properties.
        if kind in kinds or (kind == "properties" and "edit" in kinds):
            source = str(effective.sources.get("autonomy", "vault"))
            if source in (opted or set()):
                return Decision(
                    "auto_apply", "applied by the page's auto-apply setting", "auto_apply"
                )
            return Decision(
                "propose",
                "auto-apply is set here but has not been confirmed for this folder yet",
                NEEDS_OPT_IN,
                opt_in_source=source,
            )
    return Decision("propose", "awaiting review", "propose")
