# PyInstaller onedir build of the daemon (docs/decisions.md D8).
# Run: uv run --group build pyinstaller graite-daemon.spec --noconfirm
import glob
import os

import sqlite_vec
from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)

block_cipher = None

# sqlite-vec ships its loadable extension (vec0.so / .dylib / .dll) as a plain package file,
# which PyInstaller's hooks do not pick up on their own.
_vec_libs = [(f, "sqlite_vec") for f in glob.glob(os.path.join(os.path.dirname(sqlite_vec.__file__), "vec0.*"))]
assert _vec_libs, "sqlite_vec extension not found"

# The MCP SDK validates tool input with jsonschema, whose metaschemas are package data files,
# and reads its own version from the installed metadata.
_mcp_datas = collect_data_files("jsonschema_specifications") + copy_metadata("mcp")

# Every data file the package reads at runtime (schema.sql, catalog.json, engines.json, ...),
# found by pattern, never listed by hand: a file that is missing here only fails in the
# packaged app, where nobody is looking. tests/test_packaging.py checks the patterns cover
# every non-Python file under graite/.
DATA_PATTERNS = ["graite/**/*.json", "graite/**/*.sql", "graite/**/*.md"]
_package_datas = [
    (path, os.path.dirname(path))
    for pattern in DATA_PATTERNS
    for path in sorted(glob.glob(pattern, recursive=True))
]
assert _package_datas, "no package data files found; run pyinstaller from apps/daemon"

# onnxruntime (CPU) runs the two small voice models, Silero VAD and Smart Turn. Its shared
# libraries are loaded at runtime by the `capi` extension and must travel with it. The voice
# modules import it and numpy lazily, so the analysis needs the names spelled out.
_onnx_libs = collect_dynamic_libs("onnxruntime")

a = Analysis(
    ["graite/__main__.py"],
    pathex=[],
    binaries=_vec_libs + _onnx_libs,
    datas=_package_datas + _mcp_datas,
    hiddenimports=collect_submodules("uvicorn")
    + collect_submodules("keyring.backends")
    + collect_submodules("mcp.server")
    + collect_submodules("mcp.shared")
    + ["sqlite_vec", "mcp.types", "numpy", "onnxruntime", "onnxruntime.capi._pybind_state"],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "torch"],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="graite-daemon",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(exe, a.binaries, a.zipfiles, a.datas, strip=False, upx=False, name="graite-daemon")
