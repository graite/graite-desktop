from __future__ import annotations

from pathlib import Path

import numpy as np

from graite.voice.features import N_FRAMES, N_MELS, N_SAMPLES, fit, log_mel

GOLDEN = Path(__file__).parent / "fixtures" / "voice" / "log_mel_golden.npz"


def test_log_mel_matches_the_whisper_feature_extractor() -> None:
    """The fixture was made once with transformers' WhisperFeatureExtractor(chunk_length=8,
    do_normalize=True) on three seconds of speech; Smart Turn was trained on exactly that."""
    golden = np.load(GOLDEN)
    audio = golden["audio"].astype(np.float32) / 32767
    features = log_mel(audio)
    assert features.shape == (N_MELS, N_FRAMES) and features.dtype == np.float32
    reference = golden["features"].astype(np.float32)
    assert float(np.abs(features - reference).max()) < 1e-4


def test_audio_is_left_padded_and_keeps_its_newest_part() -> None:
    short = np.ones(1000, dtype=np.float32)
    fitted = fit(short)
    assert len(fitted) == N_SAMPLES and fitted[-1000:].all() and not fitted[:-1000].any()
    long = np.arange(N_SAMPLES + 50, dtype=np.float32)
    assert fit(long)[0] == 50 and fit(long)[-1] == N_SAMPLES + 49
