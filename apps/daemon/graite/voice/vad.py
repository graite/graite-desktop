"""Voice activity: Silero VAD (ONNX, CPU) per frame, debounced into speech start and stop."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from graite.voice.frames import FRAME_SAMPLES, FRAME_SECONDS, SAMPLE_RATE

CONTEXT = 64  # samples of the previous frame the model expects in front of each window


class Vad(Protocol):
    def prob(self, frame: bytes) -> float: ...
    def reset(self) -> None: ...


def session(path: Path) -> Any:
    """A single-threaded CPU session: these models are tiny and must not steal the cores
    the chat model and whisper are using."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


class SileroVAD:
    def __init__(self, path: Path) -> None:
        import numpy as np

        self._np = np
        self._session = session(path)
        self.reset()

    def reset(self) -> None:
        np = self._np
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, CONTEXT), dtype=np.float32)

    def prob(self, frame: bytes) -> float:
        np = self._np
        samples = np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0
        if len(samples) != FRAME_SAMPLES:
            raise ValueError("The VAD takes 512-sample frames.")
        window = np.concatenate([self._context, samples[None, :]], axis=1)
        output, self._state = self._session.run(
            None,
            {"input": window, "state": self._state, "sr": np.array(SAMPLE_RATE, dtype=np.int64)},
        )
        self._context = window[:, -CONTEXT:]
        return float(output[0][0])


class VadGate:
    """Per-frame probabilities -> "speaking" with hysteresis, like pipecat's VAD analyzer:
    speech starts after `start_secs` above the threshold and stops after `stop_secs` below."""

    def __init__(
        self, threshold: float = 0.5, start_secs: float = 0.2, stop_secs: float = 0.2
    ) -> None:
        self.threshold = threshold
        self.start_frames = max(1, round(start_secs / FRAME_SECONDS))
        self.stop_frames = max(1, round(stop_secs / FRAME_SECONDS))
        self.start_secs = self.start_frames * FRAME_SECONDS
        self.reset()

    def reset(self) -> None:
        self.speaking = False
        self._run = 0

    def feed(self, prob: float) -> bool:
        voiced = prob >= self.threshold
        if voiced != self.speaking:
            self._run += 1
            if self._run >= (self.start_frames if voiced else self.stop_frames):
                self.speaking = voiced
                self._run = 0
        else:
            self._run = 0
        return self.speaking
