/** Everything the UI is allowed to ask the host for. Implemented per platform. */
export interface DaemonInfo {
  /** Base URL of the daemon, e.g. http://127.0.0.1:8765 */
  url: string;
  /** Bearer token for every request and the events WebSocket. */
  token: string;
  /** The vault folder the daemon serves, when the host knows it. */
  vault: string | null;
  /** True when an external dev daemon owns the vault (`just dev`); switching is disabled. */
  dev: boolean;
}

/** The host has no vault to open yet: show the picker. */
export class NoVaultError extends Error {
  constructor() {
    super("no-vault");
    this.name = "NoVaultError";
  }
}

export interface VaultList {
  current: string | null;
  recent: string[];
  dev: boolean;
}

/** What a folder holds before it is opened as a vault. */
export interface VaultProbe {
  path: string;
  exists: boolean;
  is_dir: boolean;
  has_graite: boolean;
  pages: number;
  other_files: boolean;
}

/** A newer version of the app that this install can update itself to. */
export interface AppUpdate {
  version: string;
  /** The release notes, when the release has any. */
  notes: string | null;
}

export interface Platform {
  readonly kind: "desktop" | "web" | "mobile";
  getDaemonInfo(): Promise<DaemonInfo>;
  revealFolder?(path: string): Promise<void>;
  /** Open a page attachment in the system's default app. Absent on the web: use a blob URL. */
  openPath?(path: string): Promise<void>;
  /** `voice`: a live conversation. Asks for echo cancellation where the webview has it, so
   * the assistant does not hear itself; falls back to the plain microphone where it does not. */
  microphone(options?: { voice?: boolean; deviceId?: string }): Promise<MediaStream>;
  pickModelPath?(kind: "folder" | "file"): Promise<string | null>;
  /** URL the webview can load for a vault attachment (vault:// on desktop, /media on web). */
  mediaUrl(vaultRelativePath: string): string;
  // Vault selection. Absent on hosts where the daemon owns the vault (the web app).
  vaults?(): Promise<VaultList>;
  inspectVault?(path: string): Promise<VaultProbe>;
  pickFolder?(title: string): Promise<string | null>;
  /** Restart the daemon on another folder. Resolves with the new connection details. */
  openVault?(path: string, create: boolean): Promise<DaemonInfo>;
  forgetVault?(path: string): Promise<VaultList>;
  /** Fires after the host switched vaults (from any window). Returns the unsubscribe. */
  onVaultChanged?(listener: (info: DaemonInfo) => void): () => void;
  /** The app updating itself. Absent where the host has no app to update (the web app). */
  updates?: {
    /** The running version; whether this install looks for newer ones (not the Store build
     * or a dev run); and whether it can also install one itself (not a Linux system package,
     * where the user downloads it). */
    status(): Promise<{ version: string; supported: boolean; installable?: boolean }>;
    check(): Promise<AppUpdate | null>;
    /** Download and install what `check` found, then restart the app. `fraction` is null
     * while the size of the download is unknown. */
    install(onProgress?: (fraction: number | null) => void): Promise<void>;
  };
}
