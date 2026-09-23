import type { Platform } from "./types";
import { desktopPlatform } from "./desktop";
import { webPlatform } from "./web";

export type { DaemonInfo, Platform, VaultList, VaultProbe } from "./types";
export { NoVaultError } from "./types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const platform: Platform = isTauri ? desktopPlatform : webPlatform;
