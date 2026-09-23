"""Dump the daemon's OpenAPI document: `uv run python -m graite.openapi > openapi.json`.

`packages/api-types` generates TypeScript types from this file (checked in).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from graite.app import create_app
from graite.config import Settings


def main() -> None:
    settings = Settings(_env_file=None, vault=Path("/nonexistent"), token="x")  # type: ignore[call-arg]
    json.dump(create_app(settings).openapi(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
