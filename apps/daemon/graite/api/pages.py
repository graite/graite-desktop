"""Pages API: tree, read, save (optimistic concurrency), meta, create, trash, link resolve."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from graite.vault.fileops import FileOps
from graite.vault.models import ConflictError, PageDoc, TreeNode
from graite.vault.paths import VaultPathError, page_dir, page_file, validate_rel

router = APIRouter(tags=["pages"])

UI_ACTOR = "ui"


class PageDocModel(BaseModel):
    path: str
    id: str
    title: str
    icon: str | None
    frontmatter: dict[str, Any]
    body: str
    hash: str

    @classmethod
    def from_doc(cls, doc: PageDoc) -> PageDocModel:
        return cls(
            path=doc.path,
            id=doc.id,
            title=doc.title,
            icon=doc.icon,
            frontmatter=doc.frontmatter,
            body=doc.body,
            hash=doc.hash,
        )


class TreeNodeModel(BaseModel):
    path: str
    id: str
    title: str
    icon: str | None
    children: list[TreeNodeModel] = Field(default_factory=list)
    has_content: bool = False
    has_view: bool = False

    @classmethod
    def from_node(cls, node: TreeNode) -> TreeNodeModel:
        return cls(
            path=node.path,
            id=node.id,
            title=node.title,
            icon=node.icon,
            children=[cls.from_node(c) for c in node.children],
            has_content=node.has_content,
            has_view=node.has_view,
        )


class CreatePage(BaseModel):
    parent_path: str | None = None
    title: str = "Untitled"
    icon: str | None = None


class PutPage(BaseModel):
    body: str
    base_hash: str | None = None


class PutResult(BaseModel):
    hash: str


class ConflictBody(BaseModel):
    detail: str = "conflict"
    hash: str
    body: str


class PatchPage(BaseModel):
    title: str | None = None
    icon: str | None = None


class TrashResult(BaseModel):
    trash_id: str


class ResolveLink(BaseModel):
    target: str


class ResolveResult(BaseModel):
    path: str


class ErrorBody(BaseModel):
    detail: str


class EffectiveSettings(BaseModel):
    values: dict[str, Any]
    sources: dict[str, str]
    instructions: list[dict[str, str]]
    layers: list[dict[str, Any]] = Field(default_factory=list)


class AiSettings(BaseModel):
    own: dict[str, Any]
    effective: EffectiveSettings
    inherited: EffectiveSettings | None = None
    page: PageDocModel | None = None


class PutAiSettings(BaseModel):
    values: dict[str, Any]
    base_hash: str | None = None


def _ai_settings(request: Request, doc: PageDoc) -> AiSettings:
    from graite.vault import policy

    effective = policy.resolve(
        request.app.state.settings.vault, request.app.state.db, doc.path, leaf_meta=doc.frontmatter
    )
    return AiSettings(
        own={k: doc.frontmatter[k] for k in policy.KEYS if k in doc.frontmatter},
        effective=EffectiveSettings(**effective.as_dict()),
        inherited=EffectiveSettings(
            **policy.resolve(
                request.app.state.settings.vault, request.app.state.db, doc.path, leaf_meta={}
            ).as_dict()
        ),
        page=PageDocModel.from_doc(doc),
    )


def _fileops(request: Request) -> FileOps:
    ops: FileOps = request.app.state.fileops
    return ops


def _bad_path(exc: VaultPathError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


NOT_FOUND: dict[int | str, dict[str, Any]] = {404: {"model": ErrorBody}}
BAD_PATH: dict[int | str, dict[str, Any]] = {400: {"model": ErrorBody}}
CONFLICT: dict[int | str, dict[str, Any]] = {409: {"model": ConflictBody}}


class InstructionFile(BaseModel):
    source: str
    text: str
    hash: str


class PutInstructions(BaseModel):
    text: str = Field(max_length=16000)
    base_hash: str


@router.get("/vault/instructions", response_model=InstructionFile)
async def get_instructions(source: str, request: Request) -> Any:
    try:
        return await _fileops(request).read_instructions(source)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/vault/instructions", response_model=InstructionFile)
async def put_instructions(source: str, body: PutInstructions, request: Request) -> Any:
    try:
        return await _fileops(request).set_instructions(
            source, body.text, body.base_hash, actor=UI_ACTOR
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except ConflictError as exc:
        return JSONResponse(
            status_code=409, content={"detail": "conflict", "hash": exc.hash, "body": exc.body}
        )


class PageLocation(BaseModel):
    folder: str
    file: str


# A query parameter, not `/pages/{path}/location`: a child page named "location" must stay
# reachable at its own path.
@router.get("/vault/location", response_model=PageLocation, responses=BAD_PATH | NOT_FOUND)
async def page_location(path: str, request: Request) -> PageLocation:
    """Absolute folder and `page.md` of a page, for "Show in file manager"."""
    try:
        rel = validate_rel(path)
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    vault = request.app.state.settings.vault
    file = page_file(vault, rel)
    if not file.is_file():
        raise HTTPException(status_code=404, detail=f"page not found: {rel}")
    return PageLocation(folder=str(page_dir(vault, rel)), file=str(file))


@router.get("/vault/tree", response_model=list[TreeNodeModel])
async def get_tree(request: Request) -> list[TreeNodeModel]:
    return [TreeNodeModel.from_node(n) for n in await _fileops(request).tree()]


@router.post("/pages", response_model=PageDocModel, status_code=201, responses=BAD_PATH | NOT_FOUND)
async def create_page(body: CreatePage, request: Request) -> PageDocModel:
    try:
        doc = await _fileops(request).create_page(
            body.parent_path, body.title, body.icon, actor=UI_ACTOR
        )
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"parent not found: {exc}") from exc
    return PageDocModel.from_doc(doc)


@router.post(
    "/pages/{path:path}/resolve-link",
    response_model=ResolveResult,
    responses=BAD_PATH | NOT_FOUND,
)
async def resolve_link(path: str, body: ResolveLink, request: Request) -> ResolveResult:
    try:
        resolved = await _fileops(request).resolve_link(path, body.target)
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    if resolved is None:
        raise HTTPException(status_code=404, detail=f"no page for link: {body.target}")
    return ResolveResult(path=resolved)


@router.get(
    "/pages/{path:path}/ai-settings", response_model=AiSettings, responses=BAD_PATH | NOT_FOUND
)
async def get_ai_settings(path: str, request: Request) -> AiSettings:
    try:
        doc = await _fileops(request).read_page(path)
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"page not found: {exc}") from exc
    return _ai_settings(request, doc)


@router.put(
    "/pages/{path:path}/ai-settings",
    response_model=AiSettings,
    responses=BAD_PATH | NOT_FOUND | CONFLICT,
)
async def put_ai_settings(path: str, body: PutAiSettings, request: Request) -> Any:
    try:
        doc = await _fileops(request).set_ai_settings(
            path, body.values, body.base_hash, actor=UI_ACTOR
        )
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"page not found: {exc}") from exc
    except ConflictError as exc:
        return JSONResponse(
            status_code=409, content={"detail": "conflict", "hash": exc.hash, "body": exc.body}
        )
    if body.values.get("autonomy") == "auto-apply":
        from graite.review.policy import opt_in

        opt_in(request.app.state.db, path)
    return _ai_settings(request, doc)


@router.get("/pages/{path:path}", response_model=PageDocModel, responses=BAD_PATH | NOT_FOUND)
async def get_page(path: str, request: Request) -> PageDocModel:
    try:
        doc = await _fileops(request).read_page(path)
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"page not found: {exc}") from exc
    return PageDocModel.from_doc(doc)


@router.put(
    "/pages/{path:path}",
    response_model=PutResult,
    responses=BAD_PATH | NOT_FOUND | CONFLICT,
)
async def put_page(path: str, body: PutPage, request: Request) -> Any:
    try:
        doc = await _fileops(request).write_body(path, body.body, body.base_hash, actor=UI_ACTOR)
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"page not found: {exc}") from exc
    except ConflictError as exc:
        return JSONResponse(
            status_code=409, content={"detail": "conflict", "hash": exc.hash, "body": exc.body}
        )
    return PutResult(hash=doc.hash)


@router.patch("/pages/{path:path}", response_model=PageDocModel, responses=BAD_PATH | NOT_FOUND)
async def patch_page(path: str, body: PatchPage, request: Request) -> PageDocModel:
    clear_icon = "icon" in body.model_fields_set and body.icon is None
    try:
        doc = await _fileops(request).update_meta(
            path, title=body.title, icon=body.icon, clear_icon=clear_icon, actor=UI_ACTOR
        )
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"page not found: {exc}") from exc
    return PageDocModel.from_doc(doc)


@router.delete("/pages/{path:path}", response_model=TrashResult, responses=BAD_PATH | NOT_FOUND)
async def delete_page(path: str, request: Request) -> TrashResult:
    try:
        trash_id = await _fileops(request).trash_page(path, actor=UI_ACTOR)
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"page not found: {exc}") from exc
    return TrashResult(trash_id=trash_id)
