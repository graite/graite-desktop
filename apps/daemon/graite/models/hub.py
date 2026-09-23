"""Pinned Unsloth GGUF discovery and read-only local model discovery."""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import httpx

from graite.models.downloader import CatalogModel, ModelFile

SPLIT = re.compile(r"^(.*)-(\d{5})-of-(\d{5})\.gguf$", re.I)


def repository(value: str) -> str:
    value = value.strip().rstrip("/")
    if value.startswith("https://"):
        parsed = urlparse(value)
        if parsed.netloc != "huggingface.co" or parsed.query or parsed.fragment:
            raise ValueError("Use a Hugging Face link to an Unsloth GGUF repository.")
        value = parsed.path.strip("/")
    if not re.fullmatch(r"unsloth/[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise ValueError("Use an unsloth/model-name repository or its Hugging Face link.")
    return value


def model_groups(files: list[ModelFile]) -> list[list[ModelFile]]:
    """Only complete shard sets; never offer a projector or draft model alone."""
    singles: list[list[ModelFile]] = []
    split: dict[tuple[str, int], dict[int, ModelFile]] = {}
    for file in files:
        name = PurePosixPath(file.filename).name
        if not name.lower().endswith(".gguf") or any(
            word in name.lower() for word in ("mmproj", "mtp", "dflash", "drafter", "imatrix")
        ):
            continue
        match = SPLIT.match(file.filename)
        if not match:
            singles.append([file])
        else:
            prefix, index, total = match.groups()
            split.setdefault((prefix, int(total)), {})[int(index)] = file
    for (_, total), parts in split.items():
        if 1 <= total <= 256 and set(parts) == set(range(1, total + 1)):
            singles.append([parts[index] for index in range(1, total + 1)])
    return sorted(singles, key=lambda group: group[0].filename)


def entry(repo: str, revision: str, files: list[ModelFile], *, local: bool = False) -> CatalogModel:
    first = files[0]
    identity = ("local:" if local else repo + "@" + revision + ":") + first.filename
    size = sum(file.size for file in files)
    embedding = "embedding" in (repo + first.filename).lower()
    gemma = embedding and "gemma" in (repo + first.filename).lower()
    return CatalogModel(
        id=("local-" if local else "hf-") + hashlib.sha256(identity.encode()).hexdigest()[:20],
        name=PurePosixPath(first.filename).name,
        role="embedding" if embedding else "chat",
        repo=repo,
        revision=revision,
        filename=first.filename,
        sha256=first.sha256,
        size=size,
        files=files,
        ctx=2048 if embedding else 8192,
        min_ram_gb=max(2, int(size / 1e9 + 3)),
        tier="custom",
        notes=(f"{len(files)} files · " if len(files) > 1 else "")
        + ("Uses the original files in your folder." if local else "Downloaded from " + repo),
        verified_llama=None,
        source="local" if local else "huggingface",
        pooling="mean" if gemma else "last",
        embedding_family="embeddinggemma" if gemma else "",
        status="installed" if local else "available",
        local_path=first.filename if local else "",
        progress=100 if local else 0,
    )


async def browse(value: str) -> list[CatalogModel]:
    repo = repository(value)
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"https://huggingface.co/api/models/{repo}", params={"blobs": "true"}
        )
        response.raise_for_status()
        data = response.json()
    revision = data.get("sha", "")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("This repository has no usable pinned revision.")
    files = []
    for sibling in data.get("siblings", []):
        name = sibling.get("rfilename", "")
        path = PurePosixPath(name)
        lfs = sibling.get("lfs") or {}
        checksum = lfs.get("sha256", "")
        size = lfs.get("size", 0)
        if (
            name
            and not path.is_absolute()
            and ".." not in path.parts
            and "\\" not in name
            and re.fullmatch(r"[a-f0-9]{64}", checksum)
            and isinstance(size, int)
            and size > 0
        ):
            files.append(ModelFile(filename=name, size=size, sha256=checksum))
    models = [entry(repo, revision, group) for group in model_groups(files)]
    if not models:
        raise ValueError("No complete, downloadable GGUF models found in this repository.")
    return models


def scan(value: str) -> list[CatalogModel]:
    root = Path(value).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Choose a folder containing GGUF files.")
    files = []
    visited = 0
    for directory, folders, names in os.walk(root, followlinks=False):
        folders[:] = sorted(f for f in folders if not f.startswith("."))
        if len(Path(directory).relative_to(root).parts) >= 4:
            folders[:] = []
        for name in sorted(names):
            visited += 1
            if visited > 10000:
                raise ValueError("This folder is too large to scan. Choose a smaller model folder.")
            path = Path(directory) / name
            if path.suffix.lower() != ".gguf" or path.is_symlink() or not path.is_file():
                continue
            with path.open("rb") as handle:
                if handle.read(4) != b"GGUF":
                    continue
            files.append(ModelFile(filename=str(path), size=path.stat().st_size, sha256=""))
    models = [entry("", "", group, local=True) for group in model_groups(files)]
    if not models:
        raise ValueError("No complete GGUF models found. Check that all split files are present.")
    return models


def local_file(value: str) -> CatalogModel:
    selected = Path(value).expanduser().resolve(strict=True)
    match = SPLIT.match(selected.name)
    paths = [selected]
    if match:
        prefix, _, total = match.groups()
        count = int(total)
        if not 1 <= count <= 256:
            raise ValueError("Invalid split model file count.")
        paths = [
            selected.with_name(f"{prefix}-{i:05}-of-{count:05}.gguf") for i in range(1, count + 1)
        ]
    files = []
    for path in paths:
        if path.is_symlink() or not path.is_file() or path.suffix.lower() != ".gguf":
            raise ValueError("Choose a GGUF model with all of its parts in the same folder.")
        with path.open("rb") as handle:
            if handle.read(4) != b"GGUF":
                raise ValueError("This file is not a GGUF model.")
        files.append(ModelFile(filename=str(path), size=path.stat().st_size, sha256=""))
    groups = model_groups(files)
    if len(groups) != 1:
        raise ValueError("Choose a model file, not a projector or importance matrix.")
    return entry("", "", groups[0], local=True)
