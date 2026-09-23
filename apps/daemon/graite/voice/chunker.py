"""Streamed answer tokens -> sentences a TTS engine can speak.

The model writes for the eye now and then even when told not to; what reaches the voice is
plain speech: no reasoning blocks, code, markdown marks, citation numbers or URLs.
"""

from __future__ import annotations

import re

SENTENCE_END = re.compile(r"([.!?…。！？]+[\"'”’)\]]*)(\s+|$)")
MIN_CHARS = 24  # shorter pieces wait for the next sentence: every request has a fixed cost
MAX_CHARS = 240

_FENCE = re.compile(r"```[\s\S]*?(```|$)|~~~[\s\S]*?(~~~|$)")
_THINK = re.compile(r"<think>[\s\S]*?(</think>|$)")
_TOOLCALL = re.compile(r"<tool_call>[\s\S]*?(</tool_call>|$)")
_ARG_TAG = re.compile(r"</?(arg_key|arg_value|tool_call|tool_response)>")
_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_WIKI = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]")
_CITE = re.compile(r"\s*\[\d+(?:\s*,\s*\d+)*\]")
_BRACKETS = re.compile(r"\s*\[[^\]\n]{0,120}\]")  # "[Ada/Journal]": a reference, not speech
CLAUSE_END = re.compile(r"([,;:])(\s+)")
FIRST_MIN_CHARS = 36  # the first thing said may stop at a clause: it decides the wait
_URL = re.compile(r"https?://\S+")
_MARKS = re.compile(r"(\*\*|__|\*|_|`|~~)")
_LINE_START = re.compile(r"^[ \t]*(#{1,6}[ \t]+|>[ \t]*|[-*+][ \t]+|\d+[.)][ \t]+)", re.M)
_CLARIFY = re.compile(r"^[ \t>*-]*CLARIFY:[ \t]*", re.M)


def speakable(text: str) -> str:
    text = _THINK.sub(" ", text)
    # Before _MARKS, which eats the underscores and would leave "<toolcall>" unmatched.
    text = _TOOLCALL.sub(" ", text)
    text = _ARG_TAG.sub(" ", text)
    text = _FENCE.sub(" ", text)
    text = _WIKI.sub(lambda m: (m.group(2) or m.group(1)).split("/")[-1], text)
    text = _LINK.sub(r"\1", text)
    text = _CITE.sub("", text)
    text = _BRACKETS.sub("", text)
    text = _URL.sub("", text)
    text = _CLARIFY.sub("", text)
    text = _LINE_START.sub("", text)
    text = _MARKS.sub("", text)
    text = re.sub(r"[ \t]*\n+[ \t]*", ". ", text.strip())
    text = re.sub(r"([.!?…:;,])\s*\.", r"\1", text)
    return re.sub(r"\s{2,}", " ", text).strip()


class SpeechChunker:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Drop what was buffered: the model went off to use a tool and starts over."""
        self._raw = ""
        self._spoken = 0  # characters of the cleaned text already handed out
        self._started = False  # something was handed out already

    def _cleaned(self, final: bool) -> str:
        raw = self._raw
        if not final:
            # Inside an unfinished block nothing after its opening is trustworthy yet.
            for opener, closer in (
                ("<think>", "</think>"),
                ("<tool_call>", "</tool_call>"),
                ("```", "```"),
                ("~~~", "~~~"),
            ):
                start = raw.rfind(opener)
                if start != -1 and raw.count(opener) % 2 == 1 and opener == closer:
                    raw = raw[:start]
                elif start != -1 and opener != closer and closer not in raw[start:]:
                    raw = raw[:start]
            # A partial marker at the very end ("[", "[[Pa", "<thi", "**") may still change.
            raw = re.sub(r"(\[\[?[^\]\n]{0,80}|<[a-z_/]{0,10}|\*{1,2}|`{1,2})$", "", raw)
        return speakable(raw)

    def feed(self, token: str) -> list[str]:
        self._raw += token
        return self._take(final=False)

    def flush(self) -> list[str]:
        out = self._take(final=True)
        self.reset()
        return out

    def _take(self, *, final: bool) -> list[str]:
        text = self._cleaned(final)
        if len(text) < self._spoken:  # cleaning removed something already spoken; resync
            self._spoken = len(text)
        rest = text[self._spoken :]
        out: list[str] = []
        position = 0
        for match in SENTENCE_END.finditer(rest):
            if not final and match.end() == len(rest):
                break  # "3." may become "3.5": wait for what follows
            piece = rest[position : match.end()].strip()
            if len(piece) < MIN_CHARS and not final:
                continue
            if piece:
                out.extend(_split_long(piece))
            position = match.end()
        if not out and not final and not self._started:
            # Nothing said yet and no full sentence in sight: start at a clause boundary.
            for match in CLAUSE_END.finditer(rest):
                if match.end() < len(rest) and match.start() >= FIRST_MIN_CHARS:
                    out.append(rest[: match.end()].strip())
                    position = match.end()
                    break
        if final and rest[position:].strip():
            out.extend(_split_long(rest[position:].strip()))
            position = len(rest)
        elif not final and len(rest) - position > MAX_CHARS * 2:
            cut = rest.rfind(",", position, position + MAX_CHARS)
            cut = cut + 1 if cut != -1 else position + MAX_CHARS
            out.append(rest[position:cut].strip())
            position = cut
        self._spoken += position
        out = [piece for piece in out if re.search(r"\w", piece)]
        self._started = self._started or bool(out)
        return out


def _split_long(piece: str) -> list[str]:
    parts: list[str] = []
    while len(piece) > MAX_CHARS:
        cut = max(piece.rfind(", ", 0, MAX_CHARS), piece.rfind("; ", 0, MAX_CHARS))
        cut = cut + 1 if cut > MIN_CHARS else (piece.rfind(" ", 0, MAX_CHARS) or MAX_CHARS)
        parts.append(piece[:cut].strip())
        piece = piece[cut:].strip()
    return [*parts, piece] if piece else parts
