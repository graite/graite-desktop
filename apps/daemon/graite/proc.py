"""Starting child processes: no console window on Windows, the system's libraries on Linux.

`NO_WINDOW` is the `creationflags` for starting child processes without a console window.

The packaged daemon is a console program that the desktop shell starts without a console
(`CREATE_NO_WINDOW`). On Windows a console child of such a process would open a new, empty
console window of its own, so every spawn in `graite/` passes `creationflags=NO_WINDOW`
(`tests/test_proc.py` checks that). Elsewhere it is 0, the default.

`restore_system_libraries` (D124): the packaged daemon and the AppImage around it put their
own library folders first in `LD_LIBRARY_PATH`. A program the daemon starts would inherit that
and load the app's older `libstdc++` in place of the system's; an engine built with a newer
compiler then does not start at all. The daemon takes those folders out of its environment
once, at start. Its own libraries are not affected: the loader read the variable when the
process began.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Iterable
from pathlib import PurePosixPath
from typing import Final

if sys.platform == "win32":
    NO_WINDOW: Final = subprocess.CREATE_NO_WINDOW
else:
    NO_WINDOW: Final = 0


def system_library_path(value: str, bundle_dirs: Iterable[str]) -> str | None:
    """`value` (an `LD_LIBRARY_PATH`) without the app's own folders; None when nothing is left.

    Dropped: entries inside one of `bundle_dirs` (the PyInstaller folder, the mounted
    AppImage) and entries inside any AppImage mount (`.mount_…`), which an update in place
    leaves behind from the copy that was running before.
    """
    # This is a Linux variable: ":" between entries and POSIX paths, on whatever system the
    # code runs (the tests run on Windows too).
    bundles = [PurePosixPath(folder) for folder in bundle_dirs if folder]
    kept = []
    for entry in value.split(":"):
        if not entry:
            continue
        path = PurePosixPath(entry)
        if any(part.startswith(".mount_") for part in path.parts):
            continue
        if any(path == bundle or bundle in path.parents for bundle in bundles):
            continue
        kept.append(entry)
    return ":".join(kept) or None


def restore_system_libraries() -> None:
    """Programs started from here on load the system's libraries, not the app's (Linux)."""
    if not sys.platform.startswith("linux"):
        return
    value = os.environ.get("LD_LIBRARY_PATH")
    if value is None:
        return
    bundles = [getattr(sys, "_MEIPASS", ""), os.environ.get("APPDIR", "")]
    cleaned = system_library_path(value, bundles)
    if cleaned is None:
        del os.environ["LD_LIBRARY_PATH"]
    else:
        os.environ["LD_LIBRARY_PATH"] = cleaned
