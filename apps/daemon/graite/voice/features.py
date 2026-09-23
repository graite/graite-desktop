"""Whisper's log-mel front end in numpy, for the Smart Turn model.

Matches `transformers.WhisperFeatureExtractor(chunk_length=8)` with `do_normalize=True`
(see tests/test_voice_features.py for the golden check) without importing transformers.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

SAMPLE_RATE = 16000
N_FFT = 400
HOP = 160
N_MELS = 80
SECONDS = 8
N_SAMPLES = SAMPLE_RATE * SECONDS
N_FRAMES = N_SAMPLES // HOP


def _hz_to_mel(freq: Any) -> Any:
    import numpy as np

    freq = np.asarray(freq, dtype=np.float64)
    mels = freq * 3.0 / 200.0
    log_region = freq >= 1000.0
    logstep = 27.0 / np.log(6.4)
    return np.where(log_region, 15.0 + np.log(np.maximum(freq, 1e-10) / 1000.0) * logstep, mels)


def _mel_to_hz(mels: Any) -> Any:
    import numpy as np

    mels = np.asarray(mels, dtype=np.float64)
    freq = 200.0 * mels / 3.0
    log_region = mels >= 15.0
    logstep = np.log(6.4) / 27.0
    return np.where(log_region, 1000.0 * np.exp(logstep * (mels - 15.0)), freq)


@lru_cache(maxsize=1)
def mel_filters() -> Any:
    """Slaney-scale, slaney-normalised triangular filters: [N_MELS, N_FFT // 2 + 1]."""
    import numpy as np

    fft_freqs = np.linspace(0, SAMPLE_RATE / 2, N_FFT // 2 + 1)
    mel_points = np.linspace(_hz_to_mel(0.0), _hz_to_mel(SAMPLE_RATE / 2), N_MELS + 2)
    hz_points = _mel_to_hz(mel_points)
    diff = np.diff(hz_points)
    slopes = hz_points[:, None] - fft_freqs[None, :]
    down = -slopes[:-2] / diff[:-1, None]
    up = slopes[2:] / diff[1:, None]
    filters = np.maximum(0.0, np.minimum(down, up))
    filters *= (2.0 / (hz_points[2:] - hz_points[:-2]))[:, None]
    return filters.astype(np.float64)


def fit(audio: Any) -> Any:
    """The last 8 seconds, left-padded with silence: the newest audio ends the window."""
    import numpy as np

    audio = np.asarray(audio, dtype=np.float32)[-N_SAMPLES:]
    if len(audio) < N_SAMPLES:
        audio = np.concatenate([np.zeros(N_SAMPLES - len(audio), dtype=np.float32), audio])
    return audio


def log_mel(audio: Any) -> Any:
    """float32 mono 16 kHz in [-1, 1] -> [N_MELS, N_FRAMES] float32 features."""
    import numpy as np

    audio = fit(audio).astype(np.float64)
    audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    padded = np.pad(audio, N_FFT // 2, mode="reflect")
    window = np.hanning(N_FFT + 1)[:-1]
    count = 1 + (len(padded) - N_FFT) // HOP
    index = np.arange(N_FFT)[None, :] + HOP * np.arange(count)[:, None]
    power = np.abs(np.fft.rfft(padded[index] * window, axis=1)) ** 2
    mel = mel_filters() @ power.T
    log_spec = np.log10(np.maximum(mel, 1e-10))[:, :-1]
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0).astype(np.float32)
