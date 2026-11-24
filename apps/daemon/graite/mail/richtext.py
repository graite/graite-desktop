"""The small set of formatting a written mail may carry: bold, italic, lists, links, quotes.

A draft's HTML comes from the editor or from a model's answer. Before it is kept or sent it
is rebuilt from this allow-list: any other tag is dropped (its words stay), every attribute
is dropped except a link's web address, and all text is escaped again.
"""

from __future__ import annotations

from html import escape
from html.parser import HTMLParser

ALLOWED = {"p", "br", "div", "b", "strong", "i", "em", "u", "ul", "ol", "li", "a", "blockquote"}
VOID = {"br"}
DROP_WITH_CONTENT = {"script", "style", "head", "title", "iframe", "object", "svg"}
LINK_SCHEMES = ("http://", "https://", "mailto:")
MAX_CHARS = 400_000


class _Cleaner(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.open: list[str] = []
        self.skipping = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in DROP_WITH_CONTENT:
            self.skipping += 1
            return
        if self.skipping or tag not in ALLOWED:
            return
        if tag == "a":
            href = next((v or "" for k, v in attrs if k == "href"), "").strip()
            if not href.lower().startswith(LINK_SCHEMES):
                return  # not a web address: the words stay, the link goes
            self.out.append(f'<a href="{escape(href, quote=True)}">')
        else:
            self.out.append(f"<{tag}>")
        if tag not in VOID:
            self.open.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in DROP_WITH_CONTENT:
            self.skipping = max(0, self.skipping - 1)
            return
        if self.skipping or tag not in self.open:
            return
        # Close what was left open inside it, so the result is always well formed.
        while self.open:
            last = self.open.pop()
            self.out.append(f"</{last}>")
            if last == tag:
                break

    def handle_data(self, data: str) -> None:
        if not self.skipping:
            self.out.append(escape(data, quote=False))

    def result(self) -> str:
        while self.open:
            self.out.append(f"</{self.open.pop()}>")
        return "".join(self.out)


def clean(html: str) -> str:
    """`html` with only the allowed formatting left."""
    cleaner = _Cleaner()
    try:
        cleaner.feed(html[:MAX_CHARS])
        cleaner.close()
    except Exception:  # broken markup: keep what was read so far
        pass
    return cleaner.result()


def from_text(text: str) -> str:
    """Plain text as HTML: a paragraph per block, line breaks kept."""
    blocks = [b for b in text.replace("\r\n", "\n").split("\n\n")]
    return "".join(
        "<p>"
        + "<br>".join(escape(line, quote=False) for line in block.strip("\n").split("\n"))
        + "</p>"
        for block in blocks
        if block.strip()
    )


def quoted(sender: str, date: str, text: str) -> str:
    """The mail being answered, under the reply, the way mail apps quote it."""
    return (
        f"<p><br></p><p>On {escape(date)}, {escape(sender)} wrote:</p>"
        f"<blockquote>{from_text(text.strip())}</blockquote>"
    )


def forwarded(sender: str, date: str, subject: str, to: str, text: str) -> str:
    """A mail that is passed on, under what the user writes above it."""
    head = "<br>".join(
        escape(line)
        for line in (
            "---------- Forwarded message ----------",
            f"From: {sender}",
            f"Date: {date}",
            f"Subject: {subject}",
            f"To: {to}",
        )
    )
    return f"<p><br></p><p>{head}</p>{from_text(text.strip())}"


def page(html: str) -> str:
    """The HTML part as it is sent: a small complete document."""
    return (
        '<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px">'
        f"{html}</body></html>"
    )


class _Text(HTMLParser):
    """The plain-text reading of a formatted mail: lists keep their marks, a quote its ">"."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.paragraphs: list[list[str]] = []
        self.lines: list[str] = []
        self.current = ""
        self.quote = 0
        self.lists: list[int | None] = []  # a counter for a numbered list, None for bullets
        self.links: list[str] = []

    def _line(self) -> None:
        self.lines.append("> " * self.quote + self.current.strip())
        self.current = ""

    def _paragraph(self) -> None:
        if self.current.strip():
            self._line()
        self.current = ""
        if any(line.strip("> ") for line in self.lines):
            self.paragraphs.append(self.lines)
        self.lines = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("p", "div"):
            self._paragraph()
        elif tag == "blockquote":
            self._paragraph()
            self.quote += 1
        elif tag in ("ul", "ol"):
            self._paragraph()
            self.lists.append(0 if tag == "ol" else None)
        elif tag == "li":
            if self.current.strip():
                self._line()
            count = self.lists[-1] if self.lists else None
            if count is None:
                self.current = "- "
            else:
                self.lists[-1] = count + 1
                self.current = f"{count + 1}. "
        elif tag == "br":
            self._line()
        elif tag == "a":
            self.links.append(next((v or "" for k, v in attrs if k == "href"), ""))

    def handle_endtag(self, tag: str) -> None:
        if tag in ("p", "div"):
            self._paragraph()
        elif tag == "blockquote":
            self._paragraph()
            self.quote = max(0, self.quote - 1)
        elif tag in ("ul", "ol"):
            self._paragraph()
            if self.lists:
                self.lists.pop()
        elif tag == "li":
            if self.current.strip():
                self._line()
        elif tag == "a" and self.links:
            href = self.links.pop()
            # The address goes along in the text when the words do not already say it.
            if href and href.removeprefix("mailto:") not in self.current:
                self.current += f" ({href})"

    def handle_data(self, data: str) -> None:
        if not data.strip():
            self.current += " " if data else ""
            return
        # Runs of spaces and line ends are one space; the ones at the edges separate words.
        words = " ".join(data.split())
        self.current += (" " if data[0].isspace() else "") + words
        self.current += " " if data[-1].isspace() else ""


def to_text(html: str) -> str:
    reader = _Text()
    try:
        reader.feed(html)
        reader.close()
    except Exception:  # broken markup: what was read so far
        pass
    reader._paragraph()
    return "\n\n".join("\n".join(lines) for lines in reader.paragraphs)
