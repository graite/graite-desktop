"""Microphone audio arrives in whatever chunks the client sends; the VAD wants 512 samples."""

from __future__ import annotations

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512  # 32 ms: the window Silero VAD v5 is trained on at 16 kHz
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE


class Reframer:
    """PCM16LE bytes in, fixed 512-sample frames out."""

    def __init__(self) -> None:
        self._rest = b""

    def feed(self, data: bytes) -> list[bytes]:
        data = self._rest + data
        cut = len(data) - len(data) % FRAME_BYTES
        self._rest = data[cut:]
        return [data[i : i + FRAME_BYTES] for i in range(0, cut, FRAME_BYTES)]

    def reset(self) -> None:
        self._rest = b""
