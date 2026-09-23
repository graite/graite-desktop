"""Bounded decoding using bundled libraries; no external ffmpeg or cloud service."""

from __future__ import annotations

import io
import threading
import wave
from pathlib import Path

import av
import pypdfium2 as pdfium
from PIL import Image, ImageOps

AUDIO = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
}
IMAGES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}
MIMES = {**AUDIO, **IMAGES, ".pdf": "application/pdf", ".md": "text/markdown"}
MAX_BYTES = 200 * 1024 * 1024
MAX_SECONDS = 3600
MAX_PAGES = 100


def audio_wav(path: Path, *, rate: int = 16000, max_seconds: int = MAX_SECONDS) -> bytes:
    """Any supported recording as mono 16-bit WAV (16 kHz for speech recognition, 24 kHz for a
    voice reference)."""
    output = io.BytesIO()
    try:
        with (
            av.open(
                str(path),
                options={
                    "format_whitelist": "wav,mp3,mov,matroska,webm,ogg,flac,aac",
                    "protocol_whitelist": "file",
                },
            ) as container,
            wave.open(output, "wb") as wav,
        ):
            if not container.streams.audio:
                raise ValueError("This file does not contain audio.")
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
            samples = 0
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame):
                    samples += converted.samples
                    if samples > rate * max_seconds:
                        raise ValueError(
                            "Recordings can be up to one hour. Split longer files first."
                            if max_seconds == MAX_SECONDS
                            else f"Use a recording of up to {max_seconds} seconds."
                        )
                    wav.writeframesraw(bytes(converted.planes[0])[: converted.samples * 2])
            for converted in resampler.resample(None):
                wav.writeframesraw(bytes(converted.planes[0])[: converted.samples * 2])
            if samples == 0:
                raise ValueError("The recording is empty.")
    except av.error.FFmpegError as exc:
        raise ValueError(
            "This audio file could not be decoded. Try exporting it as WAV or MP3."
        ) from exc
    return output.getvalue()


_RENDER_LOCK = threading.Lock()  # PDFium is not thread safe, even for different documents.


def page_count(path: Path) -> int:
    with _RENDER_LOCK:
        return _page_count(path)


def render_page(path: Path, index: int = 0) -> bytes:
    with _RENDER_LOCK:
        return _render_page(path, index)


def pdf_text(path: Path, *, max_chars: int = 400_000) -> tuple[str, int]:
    """(text layer, page count) of a PDF; empty text means the PDF needs OCR."""
    with _RENDER_LOCK:
        try:
            with pdfium.PdfDocument(str(path)) as doc:
                count = len(doc)
                if not 0 < count <= MAX_PAGES:
                    raise ValueError(
                        "Documents can contain up to 100 pages. Split larger PDFs first."
                    )
                parts: list[str] = []
                total = 0
                for index in range(count):
                    page = doc[index]
                    try:
                        textpage = page.get_textpage()
                        try:
                            text = textpage.get_text_range()
                        finally:
                            textpage.close()
                    finally:
                        page.close()
                    if text.strip():
                        parts.append(f"\n\n<!-- page {index + 1} -->\n{text.strip()}")
                        total += len(text)
                    if total > max_chars:
                        break
                return "".join(parts).strip(), count
        except pdfium.PdfiumError as exc:
            raise ValueError(
                "This PDF could not be opened. Remove its password or export it again."
            ) from exc


def _page_count(path: Path) -> int:
    if path.suffix.lower() == ".pdf":
        try:
            with pdfium.PdfDocument(str(path)) as doc:
                count = len(doc)
                if not 0 < count <= MAX_PAGES:
                    raise ValueError(
                        "Documents can contain up to 100 pages. Split larger PDFs first."
                    )
                return count
        except pdfium.PdfiumError as exc:
            raise ValueError(
                "This PDF could not be opened. Remove its password or export it again."
            ) from exc
    with Image.open(path) as image:
        if getattr(image, "n_frames", 1) > 1:
            raise ValueError("Use a PDF for documents with multiple pages.")
        if image.width * image.height > 40_000_000:
            raise ValueError("Use an image smaller than 40 megapixels.")
        image.verify()
    return 1


def _render_page(path: Path, index: int = 0) -> bytes:
    if path.suffix.lower() == ".pdf":
        with pdfium.PdfDocument(str(path)) as doc:
            if not 0 <= index < len(doc):
                raise ValueError("That PDF page does not exist.")
            page = doc[index]
            try:
                scale = min(2.5, 2200 / max(page.get_size()))
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil().convert("RGB")
                finally:
                    bitmap.close()
            finally:
                page.close()
    else:
        with Image.open(path) as original:
            image = ImageOps.exif_transpose(original).convert("RGB")
            image.thumbnail((2200, 2200))
    output = io.BytesIO()
    image.save(output, "PNG")
    image.close()
    return output.getvalue()
