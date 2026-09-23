import io
import wave

import pytest

from graite.models.speech import validate_audio


def test_speech_rejects_invalid_audio() -> None:
    with pytest.raises(ValueError, match="WAV"):
        validate_audio(b"not audio")


def test_speech_checks_duration_and_format() -> None:
    for seconds, width, valid in [(1, 2, True), (301, 2, False), (1, 1, False)]:
        stream = io.BytesIO()
        with wave.open(stream, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(width)
            wav.setframerate(16000)
            wav.writeframes(b"\0" * (seconds * 16000 * width))
        if valid:
            validate_audio(stream.getvalue())
        else:
            with pytest.raises(ValueError):
                validate_audio(stream.getvalue())


def test_transcript_paragraphs_preserve_words_and_existing_breaks() -> None:
    from graite.models.speech import readable_transcript

    source = " ".join(["A short sentence."] * 60) + "\n\nFinal thought."
    result = readable_transcript(source)
    assert result.split() == source.split()
    assert result.count("\n\n") >= 3
    assert result.endswith("\n\nFinal thought.")
    assert max(len(p.split()) for p in result.split("\n\n")) <= 85
