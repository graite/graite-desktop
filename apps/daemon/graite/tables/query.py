"""The filter and sort language of `graite:table` blocks, compiled to parameterized SQL.

    category = "Travel" and amount > 100
    not (status in [done, dropped]) or due is empty
    `Project name` contains atlas

Column names are bare words or `backquoted`; values are "quoted", numbers, true/false, or a
bare word (read as text). Every value becomes a bound parameter and every column name is
checked against the table, so nothing a model or a user writes reaches SQL as text.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

_TOKEN = re.compile(
    r"""\s*(?:
      (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
    | (?P<col>`[^`]+`)
    | (?P<num>-?\d+(?:\.\d+)?(?![\w-]))
    | (?P<op>==|!=|<>|<=|>=|=|<|>|\(|\)|\[|\]|,)
    | (?P<word>[^\s"'`()\[\],=!<>]+)
    )""",
    re.VERBOSE,
)
NUMERIC = ("number", "currency", "percent")
KEYWORDS = {"and", "or", "not", "in", "is", "empty", "contains", "true", "false"}
COMPARE = {"=": "=", "==": "=", "!=": "!=", "<>": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">="}


class QueryError(ValueError):
    """The filter or sort text cannot be understood; the message says where."""


@dataclass
class Token:
    kind: str  # str | col | num | op | word
    text: str
    pos: int

    @property
    def keyword(self) -> str | None:
        return self.text.lower() if self.kind == "word" and self.text.lower() in KEYWORDS else None


def tokenize(text: str) -> list[Token]:
    tokens: list[Token] = []
    pos = 0
    while pos < len(text):
        if text[pos:].strip() == "":
            break
        match = _TOKEN.match(text, pos)
        if not match or match.end() == pos:
            raise QueryError(f"Cannot read the filter at {text[pos : pos + 12]!r}.")
        kind = match.lastgroup or ""
        tokens.append(Token(kind, match.group(kind), match.start(kind)))
        pos = match.end()
    return tokens


@dataclass
class Compiled:
    sql: str
    params: list[Any]
    columns: set[str]


class _Parser:
    def __init__(self, text: str, resolve: Callable[[str], tuple[str, str]]) -> None:
        self.tokens = tokenize(text)
        self.i = 0
        self.resolve = resolve  # name -> (quoted SQL identifier, column type)
        self.params: list[Any] = []
        self.columns: set[str] = set()

    def peek(self) -> Token | None:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def take(self) -> Token:
        token = self.peek()
        if token is None:
            raise QueryError("The filter ends too early.")
        self.i += 1
        return token

    def accept_kw(self, *words: str) -> bool:
        token = self.peek()
        if token is not None and token.keyword in words:
            self.i += 1
            return True
        return False

    def expect_op(self, op: str) -> None:
        token = self.take()
        if token.kind != "op" or token.text != op:
            raise QueryError(f"Expected {op!r} but found {token.text!r}.")

    def parse(self) -> str:
        sql = self.or_()
        if self.peek() is not None:
            raise QueryError(f"Unexpected {self.peek().text!r} in the filter.")  # type: ignore[union-attr]
        return sql

    def or_(self) -> str:
        parts = [self.and_()]
        while self.accept_kw("or"):
            parts.append(self.and_())
        return parts[0] if len(parts) == 1 else "(" + " OR ".join(parts) + ")"

    def and_(self) -> str:
        parts = [self.not_()]
        while self.accept_kw("and"):
            parts.append(self.not_())
        return parts[0] if len(parts) == 1 else "(" + " AND ".join(parts) + ")"

    def not_(self) -> str:
        if self.accept_kw("not"):
            return f"(NOT {self.not_()})"
        token = self.peek()
        if token is not None and token.kind == "op" and token.text == "(":
            self.i += 1
            inner = self.or_()
            self.expect_op(")")
            return inner
        return self.comparison()

    def column(self) -> tuple[str, str]:
        token = self.take()
        if token.kind == "col":
            name = token.text[1:-1]
        elif token.kind == "word" and token.keyword is None:
            name = token.text
        else:
            raise QueryError(f"Expected a column name but found {token.text!r}.")
        self.columns.add(name)
        return self.resolve(name)

    def value(self, kind: str) -> Any:
        token = self.take()
        if token.kind == "str":
            return re.sub(r"\\(.)", r"\1", token.text[1:-1])
        if token.kind == "num":
            if kind not in NUMERIC:
                return token.text
            number = float(token.text)
            return int(number) if number.is_integer() else number
        if token.keyword in ("true", "false"):
            value = token.keyword == "true"
            return int(value) if kind == "checkbox" else token.text
        if token.kind == "word" and token.keyword is None:
            return token.text
        raise QueryError(f"Expected a value but found {token.text!r}.")

    def bind(self, value: Any) -> str:
        self.params.append(value)
        return "?"

    def element(self, col: str, value: Any) -> str:
        """A multi-select cell (`a; b`) holds `value` as one whole element."""
        items = f"';' || lower(replace(CAST({col} AS TEXT), '; ', ';')) || ';'"
        return f"instr({items}, ';' || lower({self.bind(str(value).strip())}) || ';') > 0"

    def comparison(self) -> str:
        col, kind = self.column()
        text = kind not in (*NUMERIC, "checkbox")
        multi = kind == "multi_select"
        if self.accept_kw("is"):
            negate = self.accept_kw("not")
            if not self.accept_kw("empty"):
                raise QueryError("Write `is empty` or `is not empty`.")
            empty = f"({col} IS NULL OR {col} = '')"
            return f"(NOT {empty})" if negate else empty
        negate = self.accept_kw("not")
        if self.accept_kw("contains"):
            needle = str(self.value("text"))
            sql = f"instr(lower(CAST({col} AS TEXT)), lower({self.bind(needle)})) > 0"
            return f"(NOT {sql})" if negate else sql
        if self.accept_kw("in"):
            self.expect_op("[")
            items: list[str] = []
            while True:
                items.append(self.bind(self.value(kind)))
                token = self.take()
                if token.kind == "op" and token.text == "]":
                    break
                if token.kind != "op" or token.text != ",":
                    raise QueryError("Separate list values with commas: status in [a, b].")
            if multi:
                values = self.params[-len(items) :]
                del self.params[-len(items) :]
                sql = "(" + " OR ".join(self.element(col, v) for v in values) + ")"
            else:
                collate = " COLLATE NOCASE" if text else ""
                sql = f"{col}{collate} IN ({', '.join(items)})"
            return f"(NOT {sql})" if negate else sql
        if negate:
            raise QueryError("`not` goes before a condition, or before `in` / `contains`.")
        token = self.take()
        if token.kind != "op" or token.text not in COMPARE:
            raise QueryError(f"Expected a comparison such as = or > but found {token.text!r}.")
        op = COMPARE[token.text]
        value = self.value(kind)
        if multi and op in ("=", "!="):
            sql = self.element(col, value)
            # A row without that element, empty rows included, is "not equal".
            return f"(NOT {sql} OR {col} IS NULL)" if op == "!=" else sql
        collate = " COLLATE NOCASE" if text and isinstance(value, str) else ""
        return f"{col}{collate} {op} {self.bind(value)}"


def compile_filter(text: str | None, resolve: Callable[[str], tuple[str, str]]) -> Compiled:
    if not text or not text.strip():
        return Compiled("1", [], set())
    parser = _Parser(text, resolve)
    return Compiled(parser.parse(), parser.params, parser.columns)


def parse_sort(value: str | list[str] | None) -> list[tuple[str, bool]]:
    """`"date desc, amount"` or `["-date", "amount"]` -> [(column, descending)]."""
    if not value:
        return []
    items = value if isinstance(value, list) else value.split(",")
    out: list[tuple[str, bool]] = []
    for raw in items:
        item = str(raw).strip()
        if not item:
            continue
        desc = False
        if item.startswith("-"):
            item, desc = item[1:].strip(), True
        else:
            match = re.fullmatch(r"(.+?)\s+(asc|desc)", item, re.IGNORECASE)
            if match:
                item, desc = match.group(1).strip(), match.group(2).lower() == "desc"
        if item.startswith("`") and item.endswith("`"):
            item = item[1:-1]
        out.append((item, desc))
    return out
