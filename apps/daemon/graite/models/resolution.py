"""Page model overrides choose installed models, otherwise fall back visibly."""

from __future__ import annotations

from typing import Any

from graite.models.config import AIConfig
from graite.models.connections import get_store
from graite.models.downloader import CatalogModel
from graite.vault import frontmatter


def resolve(
    config: AIConfig,
    meta: dict[str, Any],
    instructions: list[dict[str, str]],
    installed: dict[str, CatalogModel],
) -> tuple[AIConfig, str | None]:
    selected = None
    for entry in instructions:
        fields, _ = frontmatter.split(entry["text"])
        if isinstance(fields.get("model"), str):
            selected = fields["model"]
    selected = meta.get("model", selected)
    if not isinstance(selected, str) or not selected.strip():
        return config, None
    selected = selected.strip()
    if selected.startswith("m_"):
        store = get_store()
        found = store.resolve(selected) if store else None
        if found is None:
            return config, "The page's saved model no longer exists. Using your default model."
        connection, saved = found
        return config.model_copy(
            update={
                "provider": connection.kind,
                "base_url": connection.base_url,
                "model": saved.model,
                "connection_id": connection.id,
                "saved_model_id": saved.id,
            }
        ), None
    model = installed.get(selected)
    if model and model.status == "installed" and model.role == "chat":
        return config.model_copy(
            update={
                "provider": "local",
                "model_path": model.local_path,
                "connection_id": None,
                "saved_model_id": None,
            }
        ), None
    if config.provider != "local" and model is None:
        return config.model_copy(update={"model": selected}), None
    return config, f"The page's model ({selected}) is not installed. Using your default model."
