"""Native engines Graite installs for the user: the chat engine (`llama-server`) and the voice
engine (`crispasr`).

`engines.json`, shipped with the app, pins the version Graite was tested with and lists one
build per platform and backend with its checksum. Installing downloads the right build,
verifies it, unpacks it into `<app_dir>/bin/<engine>/<variant>/<version>/`, runs it once, and
only then points `current` at it; the previous version stays for a roll back. A path the user
typed under Advanced always wins over an installed engine.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import shutil
import stat
import tarfile
import zipfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from graite.events import EventBus
from graite.models.fetch import fetch
from graite.models.hardware import Hardware
from graite.proc import NO_WINDOW

log = logging.getLogger("graite.engines")
CATALOG_PATH = Path(__file__).with_name("engines.json")
POINTER = "current"
PREVIOUS = "previous"
# A build made on this computer (scripts/build-voice-engine.sh), for instance with CUDA where
# upstream only ships a processor build. It is not in the catalog and wins over catalog builds
# unless the user picked one of those explicitly.
LOCAL = "local"
KEEP_VERSIONS = 2


class Archive(BaseModel):
    url: str
    sha256: str
    size: int


class Variant(BaseModel):
    id: str
    os: str
    arch: str
    backend: str
    label: str
    archives: list[Archive]

    @property
    def size(self) -> int:
        return sum(a.size for a in self.archives)


class Engine(BaseModel):
    id: str
    name: str
    binary: str
    version: str
    repo: str
    license: str
    purpose: str
    variants: list[Variant]


class EngineState(BaseModel):
    """What the UI shows for one engine."""

    id: str
    name: str
    purpose: str
    version: str  # the version this Graite release was tested with
    installed_version: str | None = None
    installed_variant: str | None = None
    previous_version: str | None = None
    update_available: bool = False
    recommended: str | None = None
    recommended_label: str | None = None
    recommended_size: int = 0
    reason: str = ""
    variants: list[Variant] = Field(default_factory=list)
    custom_path: str = ""  # a build of the user's own (Advanced); it overrides the installed one
    path: str = ""  # what will actually run
    status: str = "idle"  # idle | downloading | verifying | installing | error
    progress: float = 0
    error: str | None = None


def catalog() -> list[Engine]:
    return [Engine.model_validate(e) for e in json.loads(CATALOG_PATH.read_text())["engines"]]


def host() -> tuple[str, str]:
    system = {"Darwin": "darwin", "Windows": "windows"}.get(platform.system(), "linux")
    machine = platform.machine().lower()
    return system, "arm64" if machine in ("arm64", "aarch64") else "x64"


def binary_name(engine: Engine, system: str | None = None) -> str:
    return engine.binary + (".exe" if (system or host()[0]) == "windows" else "")


def candidates(engine: Engine, system: str, arch: str) -> list[Variant]:
    return [v for v in engine.variants if v.os == system and v.arch == arch]


def recommend(
    engine: Engine, hardware: Hardware, system: str, arch: str
) -> tuple[Variant | None, str]:
    """The build to install without asking, and why, in plain words. Vulkan before CUDA: a
    tenth of the download, no dependency on a CUDA version, and it runs on every vendor's
    card. CUDA stays a choice under Advanced."""
    available = {v.backend: v for v in candidates(engine, system, arch)}
    if not available:
        return None, "There is no ready-made build for this computer yet."
    if "metal" in available:
        return available["metal"], "Uses your Mac's graphics chip."
    if hardware.gpu and "vulkan" in available:
        return available["vulkan"], f"Uses your graphics card ({hardware.gpu.split(' · ')[0]})."
    if "cpu" in available:
        if hardware.gpu:
            return available["cpu"], (
                "Runs on the processor: there is no ready-made graphics-card build for this "
                "computer, so it may be slow."
            )
        return available["cpu"], "Runs on the processor; no supported graphics card was found."
    first = next(iter(available.values()))
    return first, ""


def _inside(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _strip(names: list[str]) -> str:
    """The single top-level folder every entry lives in, if there is one."""
    tops = {name.split("/", 1)[0] for name in names if name.strip("/")}
    if tops & {"..", ".", ""}:
        return ""  # nothing to strip; `place` refuses the entry
    if len(tops) == 1 and all("/" in n or n.rstrip("/") in tops for n in names):
        return next(iter(tops)) + "/"
    return ""


def extract(archive: Path, destination: Path) -> None:
    """Unpack a zip or tar into `destination`, dropping a single top-level folder. Nothing may
    land outside it: absolute names, `..` and links that point out are refused."""
    destination.mkdir(parents=True, exist_ok=True)

    def place(name: str, prefix: str) -> Path | None:
        relative = name[len(prefix) :] if prefix and name.startswith(prefix) else name
        if not relative.strip("/"):
            return None
        if relative.startswith(("/", "\\")) or ".." in Path(relative).parts or ":" in relative:
            raise ValueError("The engine archive contains an unsafe path.")
        target = destination / relative
        if not _inside(destination, target.parent):
            raise ValueError("The engine archive contains an unsafe path.")
        return target

    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            prefix = _strip(bundle.namelist())
            for info in bundle.infolist():
                target = place(info.filename, prefix)
                if target is None:
                    continue
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, target.open("wb") as sink:
                    shutil.copyfileobj(source, sink)
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    target.chmod(mode | stat.S_IRUSR | stat.S_IWUSR)
        return
    with tarfile.open(archive) as tarball:
        members = tarball.getmembers()
        prefix = _strip([m.name for m in members])
        for member in members:
            target = place(member.name, prefix)
            if target is None:
                continue
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                # Library version links (libggml.so.0 -> libggml.so.0.24.0) are part of a
                # normal build; they may only point at something inside the folder.
                link = Path(member.linkname)
                if link.is_absolute() or not _inside(destination, target.parent / link):
                    raise ValueError("The engine archive contains an unsafe link.")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.unlink(missing_ok=True)
                target.symlink_to(member.linkname)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                packed = tarball.extractfile(member)
                assert packed is not None
                with packed, target.open("wb") as sink:
                    shutil.copyfileobj(packed, sink)
                target.chmod((member.mode & 0o777) | stat.S_IRUSR | stat.S_IWUSR)
            else:
                raise ValueError("The engine archive contains an unsupported entry.")


def find_binary(folder: Path, name: str) -> Path | None:
    direct = folder / name
    if direct.is_file():
        return direct
    return next((p for p in sorted(folder.rglob(name)) if p.is_file()), None)


def library_env(binary: Path) -> dict[str, str]:
    """Engines ship their libraries next to the executable; make sure the loader looks there."""
    folder = str(binary.parent)
    env = dict(os.environ)
    key = {"darwin": "DYLD_LIBRARY_PATH", "linux": "LD_LIBRARY_PATH"}.get(host()[0])
    if key:
        env[key] = folder + (os.pathsep + env[key] if env.get(key) else "")
    return env


class EngineInstaller:
    def __init__(self, app_dir: Path, events: EventBus | None = None) -> None:
        self.root = app_dir / "bin"
        self.events = events
        self.engines = {e.id: e for e in catalog()}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.progress: dict[str, dict[str, Any]] = {}

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        for task in list(self.tasks.values()):
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    # ----------------------------------------------------------------- what is installed

    def _pointer(self, engine_id: str, variant: str, name: str = POINTER) -> str | None:
        file = self.root / engine_id / variant / name
        try:
            version = file.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return version if version and Path(version).name == version else None

    def installed(self, engine_id: str) -> tuple[str, str, Path] | None:
        """(variant, version, executable) of the installed build that runs on this computer."""
        engine = self.engines.get(engine_id)
        if engine is None:
            return None
        system, arch = host()
        order = ("metal", "cuda", "vulkan", "cpu")
        variants = sorted(
            candidates(engine, system, arch),
            key=lambda v: order.index(v.backend) if v.backend in order else len(order),
        )
        chosen = self._pointer(engine_id, "", "variant")
        if chosen:
            variants.sort(key=lambda v: v.id != chosen)
        ids = [v.id for v in variants]
        ids.insert(1 if chosen and chosen != LOCAL and chosen in ids else 0, LOCAL)
        for variant_id in ids:
            version = self._pointer(engine_id, variant_id)
            if not version:
                continue
            binary = find_binary(
                self.root / engine_id / variant_id / version, binary_name(engine, system)
            )
            if binary is not None:
                return variant_id, version, binary
        return None

    def resolve(self, engine_id: str, custom_path: str = "") -> Path | None:
        """The executable to run: the user's own build, else the installed one, else `PATH`."""
        if custom_path.strip():
            custom = Path(custom_path).expanduser()
            return custom if custom.is_file() else None
        found = self.installed(engine_id)
        if found is not None:
            return found[2]
        engine = self.engines.get(engine_id)
        on_path = shutil.which(engine.binary) if engine else None
        return Path(on_path) if on_path else None

    def state(self, engine_id: str, hardware: Hardware, custom_path: str = "") -> EngineState:
        engine = self.engines[engine_id]
        system, arch = host()
        found = self.installed(engine_id)
        best, reason = recommend(engine, hardware, system, arch)
        path = self.resolve(engine_id, custom_path)
        live = self.progress.get(engine_id, {})
        local = bool(found and found[0] == LOCAL)
        if local:
            reason = "Built on this computer for its graphics card."
        return EngineState(
            id=engine.id,
            name=engine.name,
            purpose=engine.purpose,
            version=engine.version,
            installed_version=found[1] if found else None,
            installed_variant=found[0] if found else None,
            previous_version=self._pointer(engine_id, found[0], PREVIOUS) if found else None,
            # A build of the user's own is theirs to update (rerun the build script).
            update_available=bool(found and not local and found[1] != engine.version),
            recommended=best.id if best else None,
            recommended_label=best.label if best else None,
            recommended_size=best.size if best else 0,
            reason=reason,
            variants=candidates(engine, system, arch),
            custom_path=custom_path,
            path=str(path) if path else "",
            status=str(live.get("status", "idle")),
            progress=float(live.get("progress", 0)),
            error=live.get("error"),
        )

    # ----------------------------------------------------------------- installing

    def _publish(self, engine_id: str, **data: Any) -> None:
        self.progress[engine_id] = {**self.progress.get(engine_id, {}), **data}
        if self.events is not None:
            self.events.publish("engine_progress", {"id": engine_id, **self.progress[engine_id]})

    def begin(self, engine_id: str, variant_id: str | None, hardware: Hardware) -> None:
        if engine_id in self.tasks:
            return
        engine = self.engines[engine_id]
        system, arch = host()
        variant = next(
            (v for v in candidates(engine, system, arch) if v.id == variant_id), None
        ) or (recommend(engine, hardware, system, arch)[0] if variant_id is None else None)
        if variant is None:
            raise ValueError("This build is not available for this computer.")
        self._publish(engine_id, status="downloading", progress=0, error=None)
        task = asyncio.create_task(self._run(engine, variant))
        self.tasks[engine_id] = task
        task.add_done_callback(lambda _: self.tasks.pop(engine_id, None))

    async def cancel(self, engine_id: str) -> None:
        task = self.tasks.get(engine_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _run(self, engine: Engine, variant: Variant) -> None:
        try:
            await self.install(engine, variant)
            self._publish(engine.id, status="idle", progress=100, error=None)
        except asyncio.CancelledError:
            self._publish(engine.id, status="idle", progress=0, error=None)
            raise
        except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as exc:
            log.warning("installing %s failed: %s", engine.id, exc)
            detail = str(exc) if isinstance(exc, ValueError) else ""
            self._publish(
                engine.id,
                status="error",
                error=detail or "The download could not finish. Check your connection and retry.",
            )
        except Exception:  # noqa: BLE001 - network errors come in many shapes
            log.exception("installing %s failed", engine.id)
            self._publish(
                engine.id,
                status="error",
                error="The download could not finish. Check your connection and retry.",
            )

    async def install(self, engine: Engine, variant: Variant) -> Path:
        home = self.root / engine.id / variant.id
        final = home / engine.version
        staging = home / f".{engine.version}.installing"
        downloads = home / ".downloads"
        await asyncio.to_thread(shutil.rmtree, staging, True)
        total, done = max(1, variant.size), 0
        for archive in variant.archives:
            target = downloads / archive.url.rsplit("/", 1)[-1]
            base = done

            def progress(received: int, base: int = base) -> None:
                percent = round((base + received) / total * 100, 1)
                if int(percent) != int(self.progress.get(engine.id, {}).get("progress", -1)):
                    self._publish(engine.id, status="downloading", progress=percent)

            await fetch(
                archive.url,
                target,
                size=archive.size,
                sha256=archive.sha256,
                on_progress=progress,
                on_verify=lambda: self._publish(engine.id, status="verifying"),
                what="engine",
            )
            done += archive.size
            self._publish(engine.id, status="installing")
            await asyncio.to_thread(extract, target, staging)
        binary = await asyncio.to_thread(find_binary, staging, binary_name(engine))
        if binary is None:
            await asyncio.to_thread(shutil.rmtree, staging, True)
            raise ValueError("The downloaded engine does not contain the program Graite needs.")
        await asyncio.to_thread(self._prepare, binary)
        await self._smoke_test(binary)

        def publish() -> Path:
            previous = self._pointer(engine.id, variant.id)
            shutil.rmtree(final, ignore_errors=True)
            staging.rename(final)
            self._write(home / POINTER, engine.version)
            if previous and previous != engine.version:
                self._write(home / PREVIOUS, previous)
            self._write(self.root / engine.id / "variant", variant.id)
            shutil.rmtree(downloads, ignore_errors=True)
            keep = {engine.version, previous}
            for folder in home.iterdir():
                if folder.is_dir() and not folder.name.startswith(".") and folder.name not in keep:
                    shutil.rmtree(folder, ignore_errors=True)
            found = find_binary(final, binary_name(engine))
            assert found is not None
            return found

        return await asyncio.to_thread(publish)

    @staticmethod
    def _write(file: Path, value: str) -> None:
        file.parent.mkdir(parents=True, exist_ok=True)
        temp = file.with_name(f".{file.name}.tmp")
        temp.write_text(value + "\n", encoding="utf-8")
        os.replace(temp, file)

    @staticmethod
    def _prepare(binary: Path) -> None:
        for file in binary.parent.iterdir():
            if file.is_file() and not file.is_symlink() and "." not in file.name:
                file.chmod(file.stat().st_mode | stat.S_IXUSR)
        binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
        if host()[0] == "darwin":
            import subprocess

            # Files Graite downloads itself are not quarantined, but be explicit; and Apple
            # Silicon refuses unsigned code, so give an unsigned build an ad-hoc signature.
            subprocess.run(
                ["xattr", "-dr", "com.apple.quarantine", str(binary.parent)],
                capture_output=True,
                check=False,
                creationflags=NO_WINDOW,
            )
            signed = subprocess.run(
                ["codesign", "--verify", str(binary)],
                capture_output=True,
                check=False,
                creationflags=NO_WINDOW,
            )
            if signed.returncode != 0:
                subprocess.run(
                    ["codesign", "--force", "--sign", "-", str(binary)],
                    capture_output=True,
                    check=False,
                    creationflags=NO_WINDOW,
                )

    @staticmethod
    async def _smoke_test(binary: Path) -> None:
        """The build must at least start on this computer before anything points at it."""
        try:
            process = await asyncio.create_subprocess_exec(
                str(binary),
                "--version",
                env=library_env(binary),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=NO_WINDOW,
            )
            code = await asyncio.wait_for(process.wait(), 30)
        except (OSError, TimeoutError) as exc:
            raise ValueError("The engine could not start on this computer.") from exc
        if code != 0:
            raise ValueError("The engine could not start on this computer.")

    async def rollback(self, engine_id: str) -> None:
        found = self.installed(engine_id)
        if found is None:
            raise ValueError("Nothing is installed.")
        variant, version, _ = found
        previous = self._pointer(engine_id, variant, PREVIOUS)
        home = self.root / engine_id / variant
        if not previous or not await asyncio.to_thread((home / previous).is_dir):
            raise ValueError("There is no earlier version to go back to.")

        def swap() -> None:
            self._write(home / POINTER, previous)
            self._write(home / PREVIOUS, version)

        await asyncio.to_thread(swap)

    async def remove(self, engine_id: str) -> None:
        await self.cancel(engine_id)
        await asyncio.to_thread(shutil.rmtree, self.root / engine_id, True)
        self.progress.pop(engine_id, None)


_installer: EngineInstaller | None = None


def get_installer() -> EngineInstaller | None:
    return _installer


def set_installer(installer: EngineInstaller | None) -> None:
    global _installer
    _installer = installer
