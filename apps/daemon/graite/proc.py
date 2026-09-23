"""`creationflags` for starting child processes without a console window.

The packaged daemon is a console program that the desktop shell starts without a console
(`CREATE_NO_WINDOW`). On Windows a console child of such a process would open a new, empty
console window of its own, so every spawn in `graite/` passes `creationflags=NO_WINDOW`
(`tests/test_proc.py` checks that). Elsewhere it is 0, the default.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Final

if sys.platform == "win32":
    NO_WINDOW: Final = subprocess.CREATE_NO_WINDOW
else:
    NO_WINDOW: Final = 0
