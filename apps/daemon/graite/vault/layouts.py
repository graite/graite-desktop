"""Visit Markdown inside portable column layouts while leaving code examples alone."""

from __future__ import annotations

import re
from collections.abc import Callable

import yaml

FENCES = re.compile(r"(^```[^\n]*\n.*?^```[^\n]*$)", re.M | re.S)


def map_markdown(body: str, transform: Callable[[str], str], depth: int = 0) -> str:
    if depth > 20:
        raise ValueError("Column nesting is too deep.")
    pieces = FENCES.split(body)
    for index, part in enumerate(pieces):
        if index % 2 == 0:
            pieces[index] = transform(part)
        elif part.startswith("```graite:columns\n"):
            try:
                value = yaml.safe_load(part.split("\n", 1)[1].rsplit("```", 1)[0])
            except yaml.YAMLError:
                continue
            if (
                not isinstance(value, dict)
                or set(value) != {"columns"}
                or not isinstance(value["columns"], list)
                or not all(isinstance(s, str) for s in value["columns"])
            ):
                continue
            changed = [map_markdown(s, transform, depth + 1) for s in value["columns"]]
            if changed != value["columns"]:
                pieces[index] = (
                    "```graite:columns\n"
                    + yaml.safe_dump({"columns": changed}, allow_unicode=True, sort_keys=False)
                    + "```"
                )
    return "".join(pieces)
