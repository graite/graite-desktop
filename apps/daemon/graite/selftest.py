"""`graite-daemon selftest`: can this build do what it will be asked to do?

Run against the packaged (PyInstaller) daemon by `scripts/smoke-sidecar.sh`. A normal start
only proves the server comes up; the voice stack is imported lazily and the data files are
read from wherever the bundle put them, so both are exercised here. Exit code 0, or a
traceback.
"""

from __future__ import annotations

import sys


def main() -> None:
    from graite.index.db import SCHEMA_PATH
    from graite.models import downloader, engines

    assert SCHEMA_PATH.read_text(encoding="utf-8").strip(), "schema.sql is empty"
    roles = {model.role for model in downloader.catalog()}
    assert {"chat", "embedding", "speech", "vad", "turn", "tts"} <= roles, roles
    assert {engine.id for engine in engines.catalog()} >= {"llama", "crispasr"}

    import numpy as np
    import onnxruntime

    assert "CPUExecutionProvider" in onnxruntime.get_available_providers()
    from graite.voice import bargein, chunker, session, turn, vad  # noqa: F401
    from graite.voice.features import N_FRAMES, N_MELS, log_mel

    assert log_mel(np.zeros(16000, dtype=np.float32)).shape == (N_MELS, N_FRAMES)
    assert bargein.judge("wait stop", "The deadline is Friday.").interrupt

    import av  # noqa: F401 - audio decoding for voice references and recordings
    import sqlite_vec  # noqa: F401

    print("graite-daemon selftest: ok", file=sys.stderr)
