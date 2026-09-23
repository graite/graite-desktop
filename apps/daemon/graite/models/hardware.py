"""Hardware facts and conservative GGUF offload estimates."""

from __future__ import annotations

import platform
import shutil
import subprocess
from pathlib import Path
from typing import Any

import psutil
from pydantic import BaseModel

from graite.proc import NO_WINDOW


class Hardware(BaseModel):
    ram_gb: float
    available_gb: float
    gpu: str | None = None
    vram_gb: float = 0
    free_vram_gb: float = 0
    backend: str = "cpu"
    recommended_tier: str = "small"
    binary_path: str = ""


def detect() -> Hardware:
    mem = psutil.virtual_memory()
    result = Hardware(
        ram_gb=round(mem.total / 2**30, 1), available_gb=round(mem.available / 2**30, 1)
    )
    result.recommended_tier = (
        "large" if result.ram_gb >= 48 else ("default" if result.ram_gb >= 16 else "small")
    )
    result.binary_path = shutil.which("llama-server") or ""
    # An engine installed from Settings wins over one that happens to be on PATH.
    from graite.models.engines import get_installer

    installer = get_installer()
    found = installer.installed("llama") if installer is not None else None
    if found is not None:
        result.binary_path = str(found[2])
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        result.gpu, result.backend = "Apple Silicon · shared memory", "metal"
        result.vram_gb, result.free_vram_gb = result.ram_gb, result.available_gb
    elif shutil.which("nvidia-smi"):
        try:
            out = (
                subprocess.run(
                    [
                        "nvidia-smi",
                        "--query-gpu=name,memory.total,memory.free",
                        "--format=csv,noheader,nounits",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=True,
                    creationflags=NO_WINDOW,
                )
                .stdout.splitlines()[0]
                .split(",")
            )
            result.gpu = out[0].strip()
            result.vram_gb, result.free_vram_gb = float(out[1]) / 1024, float(out[2]) / 1024
            result.backend = "cuda12"
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            pass
    if result.gpu and "GB10" in result.gpu:
        result.gpu += " · shared memory"
        result.vram_gb, result.free_vram_gb = result.ram_gb, result.available_gb
        result.backend = "cuda12"
    if result.backend == "cpu" and shutil.which("vulkaninfo"):
        try:
            output = subprocess.run(
                ["vulkaninfo", "--summary"],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
                creationflags=NO_WINDOW,
            ).stdout
            names = [
                line.split("=", 1)[1].strip()
                for line in output.splitlines()
                if "deviceName" in line and "=" in line
            ]
            names = [name for name in names if "llvmpipe" not in name.lower()]
            if names:
                result.gpu, result.backend = names[0], "vulkan"
        except (OSError, subprocess.SubprocessError):
            pass
    return result


def offload(path: Path, hardware: Hardware, context: int) -> int:
    if hardware.backend == "cpu":
        return 0
    # Read tensor metadata without loading weights. Reserve memory for KV and runtime.
    from gguf import GGUFReader

    reader: Any = GGUFReader(str(path))
    fields = reader.fields
    blocks = next(
        (int(f.parts[f.data[0]][0]) for k, f in fields.items() if k.endswith(".block_count")), 0
    )
    weight_bytes = sum(int(t.n_bytes) for t in reader.tensors)
    # Split GGUF headers describe only one shard. Budget for the complete model.
    from graite.models.hub import SPLIT

    split = SPLIT.match(path.name)
    if split:
        prefix, _, total = split.groups()
        count = int(total)
        if not 1 <= count <= 256:
            return 0
        shards = [
            path.with_name(f"{prefix}-{i:05}-of-{count:05}.gguf") for i in range(1, count + 1)
        ]
        if not all(shard.is_file() for shard in shards):
            raise ValueError("Some GGUF parts are missing. Restore every file in the model folder.")
        weight_bytes = sum(shard.stat().st_size for shard in shards)
    if not blocks or not weight_bytes:
        return 0
    budget = max(0, hardware.free_vram_gb * 2**30 - 2**30 - context * 262144)
    return min(blocks + 1, int(budget / (weight_bytes / (blocks + 1))))
