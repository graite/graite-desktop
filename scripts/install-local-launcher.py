#!/usr/bin/env python3
"""Add this checkout's standalone build to the Linux app menu and desktop."""

import argparse
import hashlib
import os
import shutil
import subprocess
from pathlib import Path


def desktop_quote(value: str) -> str:
    for char in ("\\", '"', "`", "$"):
        value = value.replace(char, "\\" + char)
    return '"' + value.replace("%", "%%") + '"'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path, help="Existing vault to open")
    args = parser.parse_args()
    vault = args.vault.expanduser().resolve(strict=True)
    if not vault.is_dir():
        parser.error("--vault must be an existing folder")
    root = Path(__file__).resolve().parent.parent
    bundles = root / "apps/desktop/src-tauri/target/release/bundle/appimage"
    if not list(bundles.glob("*.AppImage")):
        parser.error("Build the app first with ./scripts/build-app.sh")
    command = " ".join(
        desktop_quote(value)
        for value in (
            "/usr/bin/env",
            "GRAITE_VAULT=" + str(vault),
            str(root / "scripts/launch-app.sh"),
        )
    )
    data_home = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    # A new filename on artwork changes avoids stale desktop-shell icon caches.
    artwork = (root / "apps/desktop/public/app-icon.svg").read_bytes()
    icon_name = "graite-local-" + hashlib.sha256(artwork).hexdigest()[:16] + ".svg"
    icon_path = data_home / "icons/hicolor/scalable/apps" / icon_name
    content = "\n".join(
        [
            "[Desktop Entry]",
            "Version=1.0",
            "Type=Application",
            "Name=Graite",
            "Comment=Your pages, connected",
            "Exec=" + command,
            "Icon=" + str(icon_path),
            "Terminal=false",
            "Categories=Office;",
            "StartupNotify=true",
            "StartupWMClass=graite-desktop",
            "X-Graite-Launcher=true",
            "",
        ]
    )
    app_menu = data_home / "applications/app.graite.desktop"
    targets = [app_menu]
    if shutil.which("xdg-user-dir"):
        desktop = Path(subprocess.check_output(["xdg-user-dir", "DESKTOP"], text=True).strip())
        if desktop.is_dir() and desktop != Path.home():
            targets.append(desktop / "Graite.desktop")
    for target in targets:
        if target.exists() and "X-Graite-Launcher=true" not in target.read_text():
            raise SystemExit(f"Refusing to replace an unrelated launcher: {target}")
    icon_path.parent.mkdir(parents=True, exist_ok=True)
    icon_path.write_bytes(artwork)
    for target in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        target.chmod(0o755)
        print(target)
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(app_menu.parent)], check=True)


if __name__ == "__main__":
    main()
