import { microphone } from "./recording";
import { invoke } from "@tauri-apps/api/core";
import {
  NoVaultError,
  type DaemonInfo,
  type Platform,
  type VaultList,
  type VaultProbe,
} from "./types";

let cached: DaemonInfo | null = null;

export const desktopPlatform: Platform = {
  kind: "desktop",
  revealFolder: (path) => invoke("reveal_folder", { path }),
  openPath: (path) => invoke("open_path", { path }),
  async microphone(options) {
    // The shell allows exactly one microphone request per `prepare_microphone`; a refused
    // constrained request used it up, so the fallback arms it again.
    const arm = () => invoke<void>("prepare_microphone");
    await arm();
    return microphone({ ...options, rearm: arm });
  },
  async pickModelPath(kind) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    return await open({
      directory: kind === "folder",
      multiple: false,
      title: kind === "folder" ? "Add model folder" : "Add GGUF model",
      filters: kind === "file" ? [{ name: "GGUF models", extensions: ["gguf"] }] : undefined,
    });
  },
  async getDaemonInfo() {
    if (cached) return cached;
    try {
      cached = await invoke<DaemonInfo>("get_daemon_info");
    } catch (e) {
      if (String(e) === "no-vault") throw new NoVaultError();
      throw e instanceof Error ? e : new Error(String(e));
    }
    return cached;
  },
  mediaUrl(path) {
    return `vault://localhost/${path.split("/").map(encodeURIComponent).join("/")}`;
  },
  vaults: () => invoke<VaultList>("list_vaults"),
  inspectVault: (path) => invoke<VaultProbe>("inspect_vault", { path }),
  async pickFolder(title) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
  async openVault(path, create) {
    cached = null; // the old daemon is gone once this resolves
    try {
      cached = await invoke<DaemonInfo>("open_vault", { path, create });
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    return cached;
  },
  forgetVault: (path) => invoke<VaultList>("forget_vault", { path }),
  onVaultChanged(listener) {
    let active = true;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<DaemonInfo>("vault-changed", (event) => {
        cached = event.payload;
        listener(event.payload);
      }).then((stop) => {
        if (active) unlisten = stop;
        else stop();
      }),
    );
    return () => {
      active = false;
      unlisten?.();
    };
  },
};
