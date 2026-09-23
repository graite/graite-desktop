import { createContext, useContext } from "react";
import type { DaemonInfo, VaultList } from "@/lib/platform";

/** The open vault and the host's ability to switch it, shared below the VaultGate. */
export interface VaultContextValue {
  info: DaemonInfo;
  /** Absent when the host cannot switch vaults (web, or an external dev daemon). */
  canSwitch: boolean;
  list: () => Promise<VaultList>;
  /** Restart the daemon on another folder; the whole workspace remounts on success. */
  switchTo: (path: string, create: boolean) => Promise<void>;
  /** Open the OS folder dialog; resolves with the chosen path or null. */
  pickFolder: () => Promise<string | null>;
  forget: (path: string) => Promise<VaultList>;
  reveal: (path: string) => Promise<void>;
}

export const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue | null {
  return useContext(VaultContext);
}
