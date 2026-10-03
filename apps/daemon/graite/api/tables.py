"""Tables API (D68): CSV tables in page `_data/` folders, queried through the SQLite cache.

Reads run as SQL on `.graite/tables.sqlite` so filter, sort and paging stay fast on large
tables. Writes are the user's own edits (D22: direct, not proposals) and go through FileOps.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from graite.tables.cache import TablesCache
from graite.tables.edit import ColumnOp, RowOp, TableConflict
from graite.tables.query import QueryError
from graite.vault.fileops import FileOps
from graite.vault.paths import VaultPathError, validate_rel

router = APIRouter(prefix="/tables", tags=["tables"])

UI_ACTOR = "ui"
MAX_IMPORT = 100 * 1024 * 1024


class ColumnModel(BaseModel):
    name: str
    type: str
    options: list[str] = Field(default_factory=list)
    # Option -> page-property palette name (gray, brown, orange, yellow, green, blue, ...).
    colors: dict[str, str] = Field(default_factory=dict)
    # ISO code of a currency column, e.g. EUR.
    currency: str | None = None
    width: int | None = None
    # Long text shows on several lines.
    wrap: bool = False
    # Non-empty cells that do not read as this type (they stay in the CSV unchanged).
    invalid: int = 0
    # Relations (D71): the target as the schema names it and its schema id, "one" or
    # "many", the forward column a reverse column mirrors, and the resolved target path
    # (null when it cannot be found). A relation cell is a list of
    # {id, label, secondary?, broken?}: label is the linked row's current display value,
    # broken marks an id that is not a row of the target.
    table: str | None = None
    table_id: str | None = None
    cardinality: str | None = None
    reverse: str | None = None
    via: str | None = None
    target: str | None = None


class TableModel(BaseModel):
    path: str
    page_path: str
    name: str
    hash: str
    row_count: int
    primary_key: str
    display: str | None = None
    display_secondary: str | None = None
    # The columns that name a row: the schema's display settings or the default.
    label_column: str | None = None
    secondary_column: str | None = None
    table_id: str | None = None
    columns: list[ColumnModel]
    # ids_missing | ids_blank:<n> | ids_duplicate:<n> | rows_long:<n> | links_broken:<n> |
    # relation_target_missing:<column> | table_id_duplicate | schema problems
    warnings: list[str] = Field(default_factory=list)


class RowModel(BaseModel):
    id: str
    cells: list[Any]


class RowsPage(TableModel):
    visible: list[str]
    total: int
    offset: int
    rows: list[RowModel]


class RowOpModel(BaseModel):
    op: Literal["insert", "update", "delete"]
    id: str | None = None
    values: dict[str, Any] = Field(default_factory=dict)
    base: dict[str, Any] | None = None
    after: str | None = None


class WriteRows(BaseModel):
    path: str
    ops: list[RowOpModel] = Field(min_length=1, max_length=5000)
    base_hash: str | None = None


class WriteResult(BaseModel):
    path: str
    hash: str
    ids: list[str] = Field(default_factory=list)


class RowConflictModel(BaseModel):
    id: str
    reason: Literal["missing", "changed"]
    column: str | None = None


class TableConflictBody(BaseModel):
    detail: str = "conflict"
    hash: str
    conflicts: list[RowConflictModel]


class CreateTable(BaseModel):
    page_path: str
    name: str = Field(min_length=1, max_length=120)
    columns: list[str] = Field(default_factory=list, max_length=200)


class ColumnOpModel(BaseModel):
    op: Literal["add", "rename", "delete", "move"]
    name: str
    to: str | None = None
    index: int | None = None


class AlterColumns(BaseModel):
    path: str
    ops: list[ColumnOpModel] = Field(min_length=1, max_length=200)
    base_hash: str | None = None


class TablePathBody(BaseModel):
    path: str


class EnsureIds(BaseModel):
    path: str
    # Also give rows that repeat an earlier id a new one (links keep the first row).
    duplicates: bool = False


class EnsureIdsResult(WriteResult):
    # Repeated id -> the new ids its later rows got.
    reassigned: dict[str, list[str]] = Field(default_factory=dict)


class RenameTable(BaseModel):
    path: str
    name: str = Field(min_length=1, max_length=120)


class AddRelation(BaseModel):
    path: str
    # The relation column: a new one, or an existing column to convert.
    column: str = Field(min_length=1, max_length=100)
    # The table it links to (a vault path such as Clients/_data/companies.csv).
    target: str
    cardinality: Literal["one", "many"] = "many"
    # Name of the reverse column on the target, or null for none.
    reverse: str | None = Field(default=None, max_length=100)


class PatchSchema(BaseModel):
    path: str
    # Merged into `<name>.schema.json`; `columns.<name>` merges key by key, null removes.
    schema_: dict[str, Any] = Field(alias="schema")


class OptionChange(BaseModel):
    path: str
    column: str
    old: str = Field(min_length=1, max_length=100)
    # The new name, or null to remove the option from every row.
    new: str | None = Field(default=None, max_length=100)


class QueryBody(BaseModel):
    # The page whose tables (with its subpages' and the tables they link to) the query reads.
    page_path: str
    sql: str = Field(min_length=1, max_length=20000)


class QueryResult(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    truncated: bool


class TypeCheck(BaseModel):
    total: int
    invalid: int
    examples: list[str]


class Resolved(BaseModel):
    path: str


CONFLICT: dict[int | str, dict[str, Any]] = {409: {"model": TableConflictBody}}


def _cache(request: Request) -> TablesCache:
    cache: TablesCache = request.app.state.tables
    return cache


def _ops(request: Request) -> FileOps:
    ops: FileOps = request.app.state.fileops
    return ops


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, FileNotFoundError):
        return HTTPException(404, str(exc) or "This table no longer exists.")
    return HTTPException(400, str(exc))


def _conflict(exc: TableConflict) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "detail": "conflict",
            "hash": exc.hash,
            "conflicts": [c.__dict__ for c in exc.conflicts],
        },
    )


@router.get("", response_model=list[TableModel])
async def list_tables(request: Request, page_path: str | None = None) -> list[dict[str, Any]]:
    try:
        page = validate_rel(page_path) if page_path else None
        infos = await asyncio.to_thread(_cache(request).tables, page)
    except (VaultPathError, FileNotFoundError) as exc:
        raise _errors(exc) from exc
    return [i.to_json() for i in infos]


@router.get("/resolve", response_model=Resolved)
async def resolve(request: Request, page_path: str, source: str) -> Resolved:
    """The table a block on `page_path` means by `source` (`_data/x.csv`, a vault path, or a
    bare name as in `![[x.csv]]`)."""
    try:
        page = validate_rel(page_path)
        return Resolved(path=await asyncio.to_thread(_cache(request).resolve, page, source))
    except (VaultPathError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.get("/rows", response_model=RowsPage)
async def rows(
    request: Request,
    path: str,
    filter: str | None = None,
    sort: str | None = None,
    columns: Annotated[list[str] | None, Query()] = None,
    search: str | None = None,
    ids: Annotated[list[str] | None, Query(max_length=1000)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=0, le=1000)] = 200,
) -> dict[str, Any]:
    cache = _cache(request)
    try:
        return await asyncio.to_thread(
            lambda: cache.select(
                path,
                filter=filter,
                sort=sort,
                columns=columns or None,
                search=search,
                ids=ids,
                offset=offset,
                limit=limit,
            )
        )
    except (QueryError, VaultPathError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("/rows", response_model=WriteResult, responses=CONFLICT)
async def write_rows(request: Request, payload: WriteRows) -> Any:
    ops = [RowOp(**o.model_dump()) for o in payload.ops]
    try:
        return await _ops(request).write_table_rows(payload.path, ops, payload.base_hash, UI_ACTOR)
    except TableConflict as exc:
        return _conflict(exc)
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("", response_model=TableModel)
async def create(request: Request, payload: CreateTable) -> dict[str, Any]:
    try:
        rel = await _ops(request).create_table(
            payload.page_path, payload.name, payload.columns, UI_ACTOR
        )
        return (await asyncio.to_thread(_cache(request).info, rel)).to_json()
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("/import", response_model=TableModel)
async def import_csv(request: Request, page_path: str, name: str) -> dict[str, Any]:
    """Copy an uploaded CSV (request body) into the page's `_data/`, adding ids."""
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_IMPORT:
            raise HTTPException(413, "Tables can be up to 100 MB.")
    if not data.strip():
        raise HTTPException(400, "This file is empty.")
    try:
        rel = await _ops(request).create_table(page_path, name, [], UI_ACTOR, data=bytes(data))
        return (await asyncio.to_thread(_cache(request).info, rel)).to_json()
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("/ensure-ids", response_model=EnsureIdsResult)
async def ensure_ids(request: Request, payload: EnsureIds) -> EnsureIdsResult:
    try:
        if payload.duplicates:
            done = await _ops(request).reassign_duplicate_ids(payload.path, UI_ACTOR)
            return EnsureIdsResult(
                path=payload.path, hash=done["hash"], reassigned=done["reassigned"]
            )
        new_hash = await _ops(request).ensure_table_ids(payload.path, UI_ACTOR)
        return EnsureIdsResult(path=payload.path, hash=new_hash)
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("/rename", response_model=TableModel)
async def rename(request: Request, payload: RenameTable) -> dict[str, Any]:
    """Rename the CSV (and schema) file; relations, fences and embeds that name it follow."""
    try:
        rel = await _ops(request).rename_table(payload.path, payload.name, UI_ACTOR)
        return (await asyncio.to_thread(_cache(request).info, rel)).to_json()
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("/relations", response_model=TableModel)
async def add_relation(request: Request, payload: AddRelation) -> dict[str, Any]:
    """Make a column a relation to another table, with an optional reverse column there."""
    try:
        await _ops(request).add_relation(
            payload.path,
            payload.column,
            payload.target,
            payload.cardinality,
            payload.reverse,
            UI_ACTOR,
        )
        return (await asyncio.to_thread(_cache(request).info, payload.path)).to_json()
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("/link-labels", response_model=TableModel)
async def refresh_link_labels(request: Request, payload: TablePathBody) -> dict[str, Any]:
    """Write this table's current display values into the links other tables hold to it."""
    try:
        await _ops(request).refresh_link_labels(payload.path, UI_ACTOR)
        return (await asyncio.to_thread(_cache(request).info, payload.path)).to_json()
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("/columns", response_model=WriteResult, responses=CONFLICT)
async def alter_columns(request: Request, payload: AlterColumns) -> Any:
    ops = [ColumnOp(**o.model_dump()) for o in payload.ops]
    try:
        new_hash = await _ops(request).alter_table_columns(
            payload.path, ops, payload.base_hash, UI_ACTOR
        )
        return WriteResult(path=payload.path, hash=new_hash)
    except TableConflict as exc:
        return _conflict(exc)
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.patch("/schema", response_model=TableModel)
async def patch_schema(request: Request, payload: PatchSchema) -> dict[str, Any]:
    try:
        await _ops(request).update_table_schema(payload.path, payload.schema_, UI_ACTOR)
        return (await asyncio.to_thread(_cache(request).info, payload.path)).to_json()
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.post("/options", response_model=WriteResult)
async def change_option(request: Request, payload: OptionChange) -> WriteResult:
    """Rename or remove a select option in every row and in the schema file."""
    try:
        new_hash = await _ops(request).replace_table_values(
            payload.path, payload.column, payload.old, payload.new, UI_ACTOR
        )
        return WriteResult(path=payload.path, hash=new_hash)
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


@router.get("/check-type", response_model=TypeCheck)
async def check_type(
    request: Request, path: str, column: str, type: str, target: str | None = None
) -> dict[str, Any]:
    """How a column's current values would read as `type` (for a relation: as rows of
    `target`), before the user switches to it."""
    try:
        return await _ops(request).check_table_type(path, column, type, target)
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc


QUERY_ROWS = 5000


def page_query(request: Request, page: str, sql: str) -> dict[str, Any]:
    """One read-only SELECT over the tables `page` may read (D72): its own, its subpages'
    and every table they link to, plus `pages`, `page_props` and `links`."""
    from graite.tables.readonly import run_query
    from graite.tables.scope import in_subtree, page_tables, query_pages, query_tables

    cache = _cache(request)
    db = _ops(request).db
    tables = query_tables(page, page_tables(cache, page, db))
    pages = query_pages(db, lambda path: in_subtree(page, path))
    return run_query(cache.db_path, tables, pages, sql, max_rows=QUERY_ROWS)


@router.post("/query", response_model=QueryResult)
async def query(request: Request, payload: QueryBody) -> dict[str, Any]:
    """Read-only SQL for charts and dashboards: writes are refused, at most 5000 rows."""
    try:
        page = validate_rel(payload.page_path)
        return await asyncio.to_thread(page_query, request, page, payload.sql)
    except (ValueError, FileNotFoundError) as exc:
        raise _errors(exc) from exc
