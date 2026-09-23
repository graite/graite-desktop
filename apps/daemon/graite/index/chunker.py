"""Split a page into sections for search, keeping its title and heading hierarchy.

Markdown is split primarily around headings. Lists and tables stay together unless they are
oversized; long sections split with overlap. `graite:view` fences are configuration, not
content, and are skipped; `graite:columns` fences are chunked column by column. The result
is deterministic: the same title and body always produce the same chunks and hashes.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

import yaml

TARGET = 1200
MAXIMUM = 2000
MINIMUM = 200
OVERLAP = 200

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE = re.compile(r"^(\s{0,3})(```+|~~~+)\s*([^\s`]*)")
_LIST = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_TABLE = re.compile(r"^\s*\|")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_EMPTY_MARK = "<!-- graite:empty -->"


@dataclass
class Chunk:
    ord: int
    kind: str
    heading_path: list[str]
    start_line: int
    end_line: int
    text: str

    @property
    def heading(self) -> str:
        return " > ".join(self.heading_path)


@dataclass
class Link:
    kind: str  # wiki | embed | md | tag
    target: str
    heading: str | None = None
    alias: str | None = None
    line: int = 0


@dataclass
class _Block:
    kind: str  # paragraph | list | table | code | heading
    lines: list[str]
    start: int
    end: int
    level: int = 0
    heading_text: str = ""
    children: list[_Block] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(self.lines).strip("\n")


def embedding_text(title: str, heading_path: list[str], text: str) -> str:
    head = " > ".join([title, *heading_path])
    return f"{head}\n{text}" if text else head


def text_hash(title: str, heading_path: list[str], text: str) -> str:
    return hashlib.sha256(embedding_text(title, heading_path, text).encode("utf-8")).hexdigest()


def _graite_fence(lang: str, body: list[str], start: int, end: int) -> list[_Block]:
    kind = lang.split(":", 1)[1]
    raw = "\n".join(body)
    if kind in ("view", "dbview", "dashboard"):
        return []
    try:
        value = yaml.safe_load(raw)
    except yaml.YAMLError:
        return [_Block("paragraph", body, start, end)]
    if kind == "columns" and isinstance(value, dict) and isinstance(value.get("columns"), list):
        blocks: list[_Block] = []
        for column in value["columns"]:
            if isinstance(column, str):
                for block in _tokenize(column.splitlines(), offset=start):
                    block.start, block.end = start, end
                    blocks.append(block)
        return blocks
    if kind == "media" and isinstance(value, dict):
        name = str(value.get("name") or value.get("file") or "").strip()
        return [_Block("paragraph", [f"Attachment: {name}"], start, end)] if name else []
    if kind == "text" and isinstance(value, dict):
        text = str(value.get("text") or value.get("body") or "").strip()
        return [_Block("paragraph", text.splitlines(), start, end)] if text else []
    if isinstance(value, str) and value.strip():
        return [_Block("paragraph", value.splitlines(), start, end)]
    return []


def _tokenize(lines: list[str], offset: int = 0) -> list[_Block]:
    """Flat blocks with 1-based line numbers (`offset` shifts them for nested content)."""
    blocks: list[_Block] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        number = offset + i + 1
        fence = _FENCE.match(line)
        if fence:
            marker = fence.group(2)
            lang = fence.group(3).lower()
            j = i + 1
            while j < n and not re.match(
                r"^\s{0,3}" + re.escape(marker[0]) + "{" + str(len(marker)) + ",}\\s*$", lines[j]
            ):
                j += 1
            body = lines[i + 1 : j]
            end = offset + min(j, n - 1) + 1
            if lang.startswith("graite:"):
                blocks.extend(_graite_fence(lang, body, number, end))
            elif body:
                blocks.append(_Block("code", body, number, end))
            i = j + 1
            continue
        if not line.strip() or line.strip() == _EMPTY_MARK:
            i += 1
            continue
        heading = _HEADING.match(line)
        if heading:
            blocks.append(
                _Block("heading", [line], number, number, len(heading.group(1)), heading.group(2))
            )
            i += 1
            continue
        if _TABLE.match(line):
            j = i
            while j < n and _TABLE.match(lines[j]):
                j += 1
            blocks.append(_Block("table", lines[i:j], number, offset + j))
            i = j
            continue
        if _LIST.match(line):
            j = i + 1
            while j < n and (
                _LIST.match(lines[j])
                or (lines[j].startswith((" ", "\t")) and lines[j].strip())
                or (
                    not lines[j].strip()
                    and j + 1 < n
                    and (_LIST.match(lines[j + 1]) or lines[j + 1].startswith((" ", "\t")))
                )
            ):
                j += 1
            blocks.append(_Block("list", lines[i:j], number, offset + j))
            i = j
            continue
        j = i + 1
        while (
            j < n
            and lines[j].strip()
            and not _HEADING.match(lines[j])
            and not _FENCE.match(lines[j])
            and not _TABLE.match(lines[j])
            and not _LIST.match(lines[j])
        ):
            j += 1
        blocks.append(_Block("paragraph", lines[i:j], number, offset + j))
        i = j
    return blocks


def _split_block(block: _Block, maximum: int, overlap: int) -> list[_Block]:
    """Split one oversized block at its natural boundaries, carrying a little overlap."""
    if len(block.text) <= maximum:
        return [block]
    pieces: list[_Block] = []
    if block.kind == "table":
        header = (
            block.lines[:2]
            if len(block.lines) > 2 and re.match(r"^\s*\|?\s*:?-", block.lines[1])
            else []
        )
        rows = block.lines[len(header) :]
        current: list[str] = []
        for row in rows:
            if current and len("\n".join(header + current + [row])) > maximum:
                pieces.append(_Block("table", header + current, block.start, block.end))
                current = current[-1:]
            current.append(row)
        if current:
            pieces.append(_Block("table", header + current, block.start, block.end))
        return pieces
    if block.kind in ("list", "code"):
        items: list[list[str]] = []
        for line in block.lines:
            if (
                block.kind == "code"
                or _LIST.match(line)
                and not line.startswith((" ", "\t"))
                or not items
            ):
                items.append([line])
            else:
                items[-1].append(line)
        current_items: list[list[str]] = []
        for item in items:
            candidate = [ln for it in current_items + [item] for ln in it]
            if current_items and len("\n".join(candidate)) > maximum:
                pieces.append(
                    _Block(
                        block.kind,
                        [ln for it in current_items for ln in it],
                        block.start,
                        block.end,
                    )
                )
                current_items = current_items[-2:] if block.kind == "list" else []
            current_items.append(item)
        if current_items:
            pieces.append(
                _Block(
                    block.kind, [ln for it in current_items for ln in it], block.start, block.end
                )
            )
        return pieces
    text = block.text
    sentences = _SENTENCE.split(text)
    current_text = ""
    for sentence in sentences:
        if current_text and len(current_text) + len(sentence) + 1 > maximum:
            pieces.append(_Block("paragraph", current_text.splitlines(), block.start, block.end))
            current_text = current_text[-overlap:].lstrip() + " " if overlap else ""
        current_text = (current_text + " " + sentence).strip() if current_text else sentence
    if current_text:
        pieces.append(_Block("paragraph", current_text.splitlines(), block.start, block.end))
    return pieces


def _pack(blocks: list[_Block], target: int, maximum: int, overlap: int) -> list[list[_Block]]:
    """Group consecutive blocks into pieces of about `target` characters."""
    groups: list[list[_Block]] = []
    current: list[_Block] = []
    size = 0
    for block in blocks:
        for part in _split_block(block, maximum, overlap):
            length = len(part.text) + 2
            if current and size + length > target:
                groups.append(current)
                current, size = [], 0
            current.append(part)
            size += length
    if current:
        groups.append(current)
    return groups


def chunk_page(
    title: str,
    body: str,
    *,
    target: int = TARGET,
    maximum: int = MAXIMUM,
    minimum: int = MINIMUM,
    overlap: int = OVERLAP,
) -> list[Chunk]:
    blocks = _tokenize(body.splitlines())
    # Sections: a heading plus everything until the next heading of any level.
    sections: list[tuple[list[str], list[_Block], int]] = []
    stack: list[tuple[int, str]] = []
    current: list[_Block] = []
    path: list[str] = []
    line = 1
    for block in blocks:
        if block.kind == "heading":
            if current or path:
                sections.append((path, current, line))
            while stack and stack[-1][0] >= block.level:
                stack.pop()
            stack.append((block.level, block.heading_text))
            path = [text for _, text in stack]
            current, line = [], block.start
        else:
            current.append(block)
    if current or path:
        sections.append((path, current, line))

    chunks: list[Chunk] = []
    for heading_path, section_blocks, heading_line in sections:
        groups = _pack(section_blocks, target, maximum, overlap) or [[]]
        for group in groups:
            text = "\n\n".join(b.text for b in group)
            kind = group[0].kind if len(group) == 1 and group[0].kind != "paragraph" else "section"
            start = group[0].start if group else heading_line
            end = group[-1].end if group else heading_line
            chunks.append(Chunk(0, kind, list(heading_path), start, end, text))

    # Small sections merge with a sibling (same parent heading) when the result still fits.
    merged: list[Chunk] = []
    for chunk in chunks:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and (len(previous.text) < minimum or len(chunk.text) < minimum)
            and previous.heading_path[:-1] == chunk.heading_path[:-1]
            and chunk.heading_path
            and previous.heading_path != chunk.heading_path
            and len(previous.text) + len(chunk.text) + 20 <= maximum
        ):
            label = "#" * len(chunk.heading_path) + " " + chunk.heading_path[-1]
            previous.text = "\n\n".join(part for part in (previous.text, label, chunk.text) if part)
            previous.end_line = chunk.end_line
            previous.kind = "section"
            continue
        merged.append(chunk)
    chunks = [c for c in merged if c.text or c.heading_path]
    for index, chunk in enumerate(chunks):
        chunk.ord = index
    if not chunks and title:
        chunks.append(Chunk(0, "title", [], 1, 1, ""))
    return chunks


_WIKI = re.compile(r"(!?)\[\[([^\]|#\n]+?)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]")
_MD = re.compile(r"(!?)\[([^\]\n]*)\]\(([^)\s]+?\.md)(?:#[^)]*)?\)")
_TAG = re.compile(r"(?<![\w/#&])#([^\W\d_][\w/-]*)")
_CODE_SPAN = re.compile(r"`[^`\n]*`")
_URL = re.compile(r"https?://\S+")


def extract_links(body: str) -> list[Link]:
    links: list[Link] = []
    seen: set[tuple[str, str]] = set()
    in_fence = False
    marker = ""
    for number, raw in enumerate(body.splitlines(), start=1):
        fence = _FENCE.match(raw)
        if fence and not in_fence:
            in_fence, marker = True, fence.group(2)
            continue
        if in_fence:
            if re.match(
                r"^\s{0,3}" + re.escape(marker[0]) + "{" + str(len(marker)) + ",}\\s*$", raw
            ):
                in_fence = False
            continue
        line = _URL.sub(" ", _CODE_SPAN.sub(" ", raw))
        for match in _WIKI.finditer(line):
            target = match.group(2).strip()
            kind = "embed" if match.group(1) else "wiki"
            if target and (target, kind) not in seen:
                seen.add((target, kind))
                links.append(Link(kind, target, match.group(3), match.group(4), number))
        for match in _MD.finditer(line):
            target = match.group(3)
            if (target, "md") not in seen:
                seen.add((target, "md"))
                links.append(Link("md", target, None, match.group(2) or None, number))
        if _HEADING.match(line):
            continue
        for match in _TAG.finditer(line):
            tag = match.group(1).rstrip("/-")
            if (tag, "tag") not in seen:
                seen.add((tag, "tag"))
                links.append(Link("tag", tag, None, None, number))
    return links


def heading_json(path: list[str]) -> str:
    return json.dumps(path, ensure_ascii=False)


def rows_for(
    title: str, page_path: str, page_id: str, body_hash: str, chunks: list[Chunk]
) -> list[dict[str, Any]]:
    return [
        {
            "page_path": page_path,
            "page_id": page_id,
            "ord": c.ord,
            "title": title,
            "heading": c.heading,
            "heading_path": heading_json(c.heading_path),
            "kind": c.kind,
            "start_line": c.start_line,
            "end_line": c.end_line,
            "text": c.text,
            "text_hash": text_hash(title, c.heading_path, c.text),
            "body_hash": body_hash,
        }
        for c in chunks
    ]
