"""Own only the subprocess started by Graite; never terminate a user's server."""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import socket
from collections import deque
from pathlib import Path

import httpx

from graite.models.config import AIConfig
from graite.models.engines import library_env
from graite.models.hardware import detect, offload
from graite.proc import NO_WINDOW

log = logging.getLogger("graite.models")


class UnsupportedModelError(ValueError):
    """The selected runtime predates this model architecture."""


def startup_error(output: str) -> ValueError:
    architecture = re.search(r"unknown model architecture: ['\"]([^'\"]+)", output)
    if architecture:
        return UnsupportedModelError(
            f"This llama-server does not support {architecture.group(1)} models. "
            "Choose a newer llama-server executable in Settings → Chat."
        )
    lines = [
        line.strip()
        for line in output.splitlines()
        if any(word in line.lower() for word in ("error", "failed", "cannot", "out of memory"))
    ]
    detail = next((line for line in lines if "error loading model:" in line), "")
    detail = detail or (lines[0] if lines else "The runtime exited before becoming ready.")
    return ValueError("Model failed to load. " + detail[-600:])


class LlamaServer:
    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.url = ""
        self.key = secrets.token_hex(32)
        self.layers = 0
        self.devices = ""
        self.warning: str | None = None
        self.chat_format: str | None = None
        self._output: deque[str] = deque(maxlen=80)
        self._reader: asyncio.Task[None] | None = None

    async def _read_output(self, stream: asyncio.StreamReader) -> None:
        while chunk := await stream.read(4096):
            text = chunk.decode(errors="replace")
            self._output.append(text)
            # Which parser llama.cpp chose decides whether tool calls arrive structured or as
            # prose; without this line a dialect mismatch is invisible. See agent.loop.
            for line in text.splitlines():
                if self.chat_format is None and "chat format" in line.lower():
                    self.chat_format = line.strip()
                    log.info("llama-server %s", self.chat_format)

    async def start(
        self, config: AIConfig, *, embedding: bool = False, pooling: str = "last", mmproj: str = ""
    ) -> None:
        self._output.clear()
        self.warning = None
        self.chat_format = None
        hardware = await asyncio.to_thread(detect)
        binary = await asyncio.to_thread(
            Path(config.binary_path or hardware.binary_path).expanduser
        )
        model = await asyncio.to_thread(Path(config.model_path).expanduser)
        if not binary.is_file():
            raise ValueError("Install the chat engine in Settings → Chat first.")
        if not model.is_file() or model.suffix.lower() != ".gguf":
            raise ValueError("Choose an existing GGUF model in Settings → Chat.")
        env = library_env(binary)  # engines carry their libraries next to the executable
        probe = await asyncio.create_subprocess_exec(
            str(binary),
            "--list-devices",
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            creationflags=NO_WINDOW,
        )
        try:
            output, _ = await asyncio.wait_for(probe.communicate(), 15)
        except BaseException:
            if probe.returncode is None:
                probe.kill()
                await probe.wait()
            raise
        if probe.returncode:
            raise ValueError("This llama-server build cannot run. Choose a compatible build.")
        self.devices = output.decode(errors="replace")[-4000:]
        self.layers = config.gpu_layers
        if self.layers == -1:
            # Hardware presence alone does not prove this binary supports GPU inference.
            if not any(x in self.devices.lower() for x in ("cuda", "metal", "vulkan")):
                hardware.backend = "cpu"
            self.layers = await asyncio.to_thread(offload, model, hardware, config.context_size)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}/v1"
        self.process = await asyncio.create_subprocess_exec(
            str(binary),
            "-m",
            str(model),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--api-key",
            self.key,
            *(
                ["--embedding", "--pooling", pooling, "--ubatch-size", "2048"]
                if embedding
                else ["--jinja"]
            ),
            *(["--mmproj", mmproj] if mmproj else []),
            "--ctx-size",
            str(config.context_size),
            "-ngl",
            str(self.layers),
            "--parallel",
            "1",
            env=env,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=NO_WINDOW,
        )
        assert self.process.stderr is not None
        self._reader = asyncio.create_task(self._read_output(self.process.stderr))
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                for _ in range(240):
                    if self.process.returncode is not None:
                        await self._reader
                        raise startup_error("".join(self._output).replace(self.key, "[redacted]"))
                    try:
                        response = await client.get(
                            f"http://127.0.0.1:{port}/health",
                            headers={"Authorization": f"Bearer {self.key}"},
                        )
                        if response.is_success:
                            return
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.5)
            raise ValueError("Model loading timed out. Try a smaller model.")
        except ValueError as exc:
            gpu_attempt = self.layers > 0 and not isinstance(exc, UnsupportedModelError)
            await self.stop()
            if gpu_attempt:
                await self.start(
                    config.model_copy(update={"gpu_layers": 0}),
                    embedding=embedding,
                    pooling=pooling,
                    mmproj=mmproj,
                )
                self.warning = "The GPU could not load this model. Running on CPU instead."
                return
            raise
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process = None
        if self._reader:
            await self._reader
            self._reader = None
