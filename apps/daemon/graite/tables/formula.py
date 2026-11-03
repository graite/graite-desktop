"""Formula columns (D75): a small expression language over one row, compiled to SQL.

    net * vat_rate / 100
    if(stage = "Won", value, value * probability / 100)
    round(days_between(issue_date, paid_on), 0)

The formula lives in `<table>.schema.json`; the cache adds it as a `GENERATED ALWAYS AS (…)
VIRTUAL` column, so filters, sorts, charts, dashboards and `run_query_ro` see it like any other
column, and nothing is written to the CSV. Generated columns cannot take bound parameters, so
the compiler writes literals itself: numbers it parsed, strings with quotes doubled, column
names checked against the table and quoted. SQLite refuses non-deterministic functions in a
generated column, so the language has no `today()`.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from graite.tables.query import QueryError

_TOKEN = re.compile(
    r"""\s*(?:
      (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
    | (?P<col>`[^`]+`)
    | (?P<num>\d+(?:\.\d+)?(?![\w]))
    | (?P<op>==|!=|<>|<=|>=|=|<|>|\(|\)|,|\+|-|\*|/)
    | (?P<word>[^\s"'`(),=!<>+\-*/]+)
    )""",
    re.VERBOSE,
)
KEYWORDS = {"and", "or", "not", "is", "empty", "true", "false"}
COMPARE = {"=": "=", "==": "=", "!=": "!=", "<>": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">="}
FORMATS = ("number", "currency", "percent", "date", "text", "checkbox")
SQL_TYPES = {"number": "REAL", "currency": "REAL", "percent": "REAL", "checkbox": "INTEGER"}
MAX_LENGTH = 2000


class FormulaError(QueryError):
    """The formula cannot be understood or refers to something it may not."""


@dataclass
class _Token:
    kind: str  # str | col | num | op | word
    text: str

    @property
    def keyword(self) -> str | None:
        return self.text.lower() if self.kind == "word" and self.text.lower() in KEYWORDS else None


def _tokenize(text: str) -> list[_Token]:
    if len(text) > MAX_LENGTH:
        raise FormulaError(f"A formula can be at most {MAX_LENGTH} characters.")
    tokens: list[_Token] = []
    pos = 0
    while pos < len(text):
        if text[pos:].strip() == "":
            break
        match = _TOKEN.match(text, pos)
        if not match or match.end() == pos:
            raise FormulaError(f"Cannot read the formula at {text[pos : pos + 12]!r}.")
        kind = match.lastgroup or ""
        tokens.append(_Token(kind, match.group(kind)))
        pos = match.end()
    return tokens


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _unescape(token: str) -> str:
    return re.sub(r"\\(.)", r"\1", token[1:-1])


def _date(x: str) -> str:
    return f"date({x})"


# name -> (min args, max args or None, SQL builder)
_FUNCTIONS: dict[str, tuple[int, int | None, Callable[[list[str]], str]]] = {
    "if": (3, 3, lambda a: f"(CASE WHEN {a[0]} THEN {a[1]} ELSE {a[2]} END)"),
    "round": (1, 2, lambda a: f"round({a[0]}, {a[1] if len(a) > 1 else '0'})"),
    "abs": (1, 1, lambda a: f"abs({a[0]})"),
    "min": (2, None, lambda a: f"min({', '.join(a)})"),
    "max": (2, None, lambda a: f"max({', '.join(a)})"),
    "coalesce": (2, None, lambda a: f"coalesce({', '.join(a)})"),
    "concat": (1, None, lambda a: "(" + " || ".join(f"coalesce({x}, '')" for x in a) + ")"),
    "days_between": (2, 2, lambda a: f"(julianday({a[1]}) - julianday({a[0]}))"),
    "add_days": (2, 2, lambda a: f"date({a[0]}, printf('%+d days', CAST({a[1]} AS INTEGER)))"),
    "year": (1, 1, lambda a: f"CAST(strftime('%Y', {a[0]}) AS INTEGER)"),
    "month": (1, 1, lambda a: f"CAST(strftime('%m', {a[0]}) AS INTEGER)"),
    "quarter": (1, 1, lambda a: f"((CAST(strftime('%m', {a[0]}) AS INTEGER) + 2) / 3)"),
    "date": (1, 1, lambda a: _date(a[0])),
    "lower": (1, 1, lambda a: f"lower({a[0]})"),
    "upper": (1, 1, lambda a: f"upper({a[0]})"),
    "length": (1, 1, lambda a: f"length({a[0]})"),
}
FUNCTIONS = tuple(sorted(_FUNCTIONS))


class _Parser:
    def __init__(self, text: str, resolve: Callable[[str], str]) -> None:
        self.tokens = _tokenize(text)
        self.i = 0
        self.resolve = resolve  # column name -> quoted SQL identifier (raises FormulaError)
        self.columns: set[str] = set()

    def peek(self, ahead: int = 0) -> _Token | None:
        n = self.i + ahead
        return self.tokens[n] if n < len(self.tokens) else None

    def take(self) -> _Token:
        token = self.peek()
        if token is None:
            raise FormulaError("The formula ends too early.")
        self.i += 1
        return token

    def accept_op(self, *ops: str) -> str | None:
        token = self.peek()
        if token is not None and token.kind == "op" and token.text in ops:
            self.i += 1
            return token.text
        return None

    def accept_kw(self, word: str) -> bool:
        token = self.peek()
        if token is not None and token.keyword == word:
            self.i += 1
            return True
        return False

    def expect_op(self, op: str) -> None:
        token = self.take()
        if token.kind != "op" or token.text != op:
            raise FormulaError(f"Expected {op!r} but found {token.text!r}.")

    def parse(self) -> str:
        if not self.tokens:
            raise FormulaError("Write a formula, e.g. net * vat_rate / 100.")
        sql = self.or_()
        token = self.peek()
        if token is not None:
            raise FormulaError(f"Unexpected {token.text!r} in the formula.")
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
        return self.comparison()

    def comparison(self) -> str:
        left = self.additive()
        if self.accept_kw("is"):
            negate = self.accept_kw("not")
            if not self.accept_kw("empty"):
                raise FormulaError("Write `is empty` or `is not empty`.")
            empty = f"({left} IS NULL OR {left} = '')"
            return f"(NOT {empty})" if negate else empty
        op = self.accept_op(*COMPARE)
        if op is None:
            return left
        return f"({left} {COMPARE[op]} {self.additive()})"

    def additive(self) -> str:
        sql = self.term()
        while (op := self.accept_op("+", "-")) is not None:
            sql = f"({sql} {op} {self.term()})"
        return sql

    def term(self) -> str:
        sql = self.unary()
        while (op := self.accept_op("*", "/")) is not None:
            right = self.unary()
            # Real division, so 1 / 2 is 0.5; dividing by zero gives an empty cell.
            sql = f"({sql} * 1.0 {op} {right})" if op == "/" else f"({sql} * {right})"
        return sql

    def unary(self) -> str:
        if self.accept_op("-"):
            return f"(-{self.unary()})"
        return self.primary()

    def primary(self) -> str:
        token = self.take()
        if token.kind == "num":
            return token.text
        if token.kind == "str":
            return _literal(_unescape(token.text))
        if token.kind == "op" and token.text == "(":
            inner = self.or_()
            self.expect_op(")")
            return inner
        if token.keyword in ("true", "false"):
            return "1" if token.keyword == "true" else "0"
        if token.kind == "word" and token.keyword is None:
            following = self.peek()
            if following is not None and following.kind == "op" and following.text == "(":
                return self.call(token.text)
            return self.column(token.text)
        if token.kind == "col":
            return self.column(token.text[1:-1])
        raise FormulaError(f"Expected a value but found {token.text!r}.")

    def call(self, name: str) -> str:
        spec = _FUNCTIONS.get(name.lower())
        if spec is None:
            known = ", ".join(FUNCTIONS)
            raise FormulaError(f"Unknown function {name!r}; use one of {known}.")
        self.expect_op("(")
        args: list[str] = []
        if not self.accept_op(")"):
            while True:
                args.append(self.or_())
                if self.accept_op(")"):
                    break
                self.expect_op(",")
        low, high, build = spec
        if len(args) < low or (high is not None and len(args) > high):
            if low == high:
                count = str(low)
            else:
                count = f"{low} or more" if high is None else f"{low}–{high}"
            raise FormulaError(f"{name}() takes {count} values, not {len(args)}.")
        return build(args)

    def column(self, name: str) -> str:
        self.columns.add(name)
        return self.resolve(name)


@dataclass
class Compiled:
    sql: str
    columns: set[str]


def compile_formula(text: str, resolve: Callable[[str], str]) -> Compiled:
    """`text` as one SQL expression; `resolve` turns a column name into a quoted identifier
    (or raises FormulaError when the formula may not use it)."""
    parser = _Parser(text, resolve)
    sql = parser.parse()
    return Compiled(sql, parser.columns)


def compile_all(
    formulas: dict[str, str], columns: Iterable[str], blocked: Iterable[str] = ()
) -> tuple[dict[str, str | None], list[str]]:
    """Every formula column of a table as SQL (None when it cannot be compiled), and the
    problems as `formula_invalid:<column>:<message>` warnings.

    `columns` are the stored columns a formula may read; formulas may read each other (in
    any order SQLite resolves) but not in a circle; `blocked` names columns they may not read
    (reverse relations, which are not stored)."""
    stored = {c.lower(): c for c in columns}
    by_lower = {name.lower(): name for name in formulas}
    no = {b.lower() for b in blocked}
    out: dict[str, str | None] = {}
    deps: dict[str, set[str]] = {}
    errors: dict[str, str] = {}

    def resolver(own: str) -> Callable[[str], str]:
        def resolve(name: str) -> str:
            low = name.lower()
            if low == own.lower():
                raise FormulaError(f"{own!r} cannot use itself.")
            if low in no:
                raise FormulaError(
                    f"{name!r} lists rows of another table; a formula can only read this row."
                )
            if low in by_lower:
                return _quote(by_lower[low])
            if low in stored:
                return _quote(stored[low])
            raise FormulaError(f"The table has no column {name!r}.")

        return resolve

    for name, text in formulas.items():
        try:
            compiled = compile_formula(text, resolver(name))
        except FormulaError as exc:
            errors[name] = str(exc)
            continue
        out[name] = compiled.sql
        deps[name] = {by_lower[c.lower()] for c in compiled.columns if c.lower() in by_lower}

    # A formula that reads a broken one, or reads in a circle, is broken too.
    state: dict[str, int] = {}

    def visit(name: str) -> bool:
        if name in errors:
            return False
        mark = state.get(name)
        if mark == 1:
            errors[name] = "The formula uses itself through other formulas."
            return False
        if mark == 2:
            return True
        state[name] = 1
        ok = True
        for dep in sorted(deps.get(name, ())):
            if not visit(dep):
                ok = False
                errors.setdefault(name, f"It uses {dep!r}, which has a problem.")
        state[name] = 2
        return ok

    for name in formulas:
        visit(name)
    for name in errors:
        out[name] = None
    warnings = [f"formula_invalid:{name}:{message}" for name, message in errors.items()]
    return {name: out.get(name) for name in formulas}, warnings


def rename_column(text: str, old: str, new: str) -> str:
    """`text` with references to column `old` now naming `new`; other text is kept as typed."""
    try:
        tokens = _tokenize(text)
    except FormulaError:
        return text
    out: list[str] = []
    pos = 0
    for n, token in enumerate(tokens):
        start = text.index(token.text, pos)
        out.append(text[pos:start])
        pos = start + len(token.text)
        name = token.text[1:-1] if token.kind == "col" else token.text
        following = tokens[n + 1] if n + 1 < len(tokens) else None
        is_call = following is not None and following.kind == "op" and following.text == "("
        is_ref = token.kind == "col" or (
            token.kind == "word" and token.keyword is None and not is_call
        )
        if is_ref and name.lower() == old.lower():
            plain = re.fullmatch(r"[A-Za-z_][\w.]*", new) and new.lower() not in KEYWORDS
            out.append(new if plain else f"`{new}`")
        else:
            out.append(token.text)
    out.append(text[pos:])
    return "".join(out)


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'
