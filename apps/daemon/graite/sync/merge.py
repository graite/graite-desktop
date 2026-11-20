"""Putting two versions of a text file together when both devices changed it.

A three-way merge by lines against the last version both devices had. A page's frontmatter
is merged key by key (`updated` always differs, and must not count as an overlap). None
means the changes overlap and a person has to choose.
"""

from __future__ import annotations

from merge3 import Merge3

from graite.vault import frontmatter as fm
from graite.vault.paths import PAGE_FILE


def mergeable(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    return name == PAGE_FILE or name.lower().endswith(".csv")


def merge_lines(base: str, kept: str, other: str) -> str | None:
    """Both sides' changes since `base` in one text, or None when they touch the same lines."""
    merge = Merge3(
        base.splitlines(keepends=True),
        kept.splitlines(keepends=True),
        other.splitlines(keepends=True),
    )
    if any(region[0] == "conflict" for region in merge.merge_regions()):
        return None
    return "".join(merge.merge_lines())


def merge_page(base: str | None, kept: str, other: str) -> str | None:
    kept_meta, kept_body = fm.split(kept)
    other_meta, other_body = fm.split(other)
    base_meta, base_body = fm.split(base) if base is not None else (kept_meta, None)
    if kept_body == other_body:
        body: str | None = kept_body
    elif base_body is None:
        body = None
    else:
        body = merge_lines(base_body, kept_body, other_body)
    if body is None:
        return None
    meta = dict(kept_meta)
    for key in {*kept_meta, *other_meta, *base_meta}:
        ours, theirs, before = kept_meta.get(key), other_meta.get(key), base_meta.get(key)
        if theirs != before and ours == before:
            if theirs is None:
                meta.pop(key, None)
            else:
                meta[key] = theirs
    stamps = [str(m["updated"]) for m in (kept_meta, other_meta) if m.get("updated")]
    if stamps:
        meta["updated"] = max(stamps)
    return fm.join(meta, body)


def three_way(path: str, base: str | None, kept: str, other: str) -> str | None:
    """`kept` (the version on disk) with `other`'s changes worked in, or None."""
    if path.rsplit("/", 1)[-1] == PAGE_FILE:
        return merge_page(base, kept, other)
    if base is None:
        return None
    return merge_lines(base, kept, other)
