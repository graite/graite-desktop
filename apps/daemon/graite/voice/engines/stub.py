"""A TTS engine that needs no model: one soft tone per word. It makes the whole voice path
testable (and audible) before a real engine is installed."""

from __future__ import annotations

import asyncio
import math
import struct
from collections.abc import AsyncIterator

from graite.voice.tts import Voice


class StubEngine:
    name = "stub"
    sample_rate = 24000

    def __init__(self, seconds_per_word: float = 0.18, delay: float = 0.0) -> None:
        self.seconds_per_word = seconds_per_word
        self.delay = delay
        self.loaded = False
        self.spoken: list[tuple[str, Voice]] = []

    async def load(self) -> None:
        self.loaded = True

    async def unload(self) -> None:
        self.loaded = False

    def memory_bytes(self) -> int:
        return 0

    async def synthesize(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        self.spoken.append((text, voice))
        samples = int(self.sample_rate * self.seconds_per_word)
        for index, _ in enumerate(text.split() or [""]):
            if self.delay:
                await asyncio.sleep(self.delay)
            pitch = 330 + 40 * (index % 3)
            yield b"".join(
                struct.pack(
                    "<h",
                    int(
                        6000
                        * math.sin(2 * math.pi * pitch * n / self.sample_rate)
                        * math.sin(math.pi * n / samples)
                    ),
                )
                for n in range(samples)
            )
