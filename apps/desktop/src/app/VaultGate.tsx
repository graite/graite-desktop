import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { NoVaultError, platform, type DaemonInfo, type VaultList } from "@/lib/platform";
import { setStorageScope } from "@/lib/storage";
import { StartupLoader } from "./StartupLoader";
import { VaultPicker } from "./VaultPicker";
import { VaultContext, type VaultContextValue } from "./vault-context";

type Phase =
  | { kind: "checking" }
  | { kind: "picker"; error?: string; busy?: boolean }
  | { kind: "error"; error: string }
  | { kind: "ready"; info: DaemonInfo };

/**
 * Decides what the window shows: the vault picker while no vault is chosen, the startup
 * loader while the daemon starts, and the workspace once it answers. Switching vaults
 * remounts the children (keyed by vault path) so nothing from the old vault lingers.
 */
export function VaultGate({ children }: { children: (info: DaemonInfo) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const ready = useCallback((info: DaemonInfo) => {
    setStorageScope(info.vault);
    setPhase({ kind: "ready", info });
  }, []);
  const check = useCallback(() => {
    setPhase({ kind: "checking" });
    platform
      .getDaemonInfo()
      .then(ready)
      .catch((e: unknown) => {
        if (e instanceof NoVaultError) setPhase({ kind: "picker" });
        else setPhase({ kind: "error", error: e instanceof Error ? e.message : String(e) });
      });
  }, [ready]);
  useEffect(check, [check]);
  useEffect(() => platform.onVaultChanged?.(ready), [ready]);
  const switchTo = useCallback(
    async (path: string, create: boolean) => {
      if (!platform.openVault) throw new Error("This app cannot switch vaults.");
      setPhase((current) =>
        current.kind === "picker" ? { ...current, busy: true, error: undefined } : current,
      );
      try {
        ready(await platform.openVault(path, create));
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        setPhase((current) =>
          current.kind === "ready" ? current : { kind: "picker", error, busy: false },
        );
        throw e;
      }
    },
    [ready],
  );
  const context = useMemo<VaultContextValue | null>(() => {
    if (phase.kind !== "ready") return null;
    const info = phase.info;
    const empty: VaultList = {
      current: info.vault,
      recent: info.vault ? [info.vault] : [],
      dev: info.dev,
    };
    return {
      info,
      canSwitch: !!platform.openVault && !info.dev,
      list: () => platform.vaults?.() ?? Promise.resolve(empty),
      switchTo,
      pickFolder: () => platform.pickFolder?.("Open a vault folder") ?? Promise.resolve(null),
      forget: (path) => platform.forgetVault?.(path) ?? Promise.resolve(empty),
      reveal: (path) => platform.revealFolder?.(path) ?? Promise.resolve(),
    };
  }, [phase, switchTo]);
  if (phase.kind === "checking") return <StartupLoader />;
  if (phase.kind === "error")
    return (
      <StartupLoader
        error={phase.error}
        onRetry={check}
        onChooseVault={platform.openVault ? () => setPhase({ kind: "picker" }) : undefined}
      />
    );
  if (phase.kind === "picker") {
    return (
      <VaultPicker
        error={phase.error}
        busy={phase.busy}
        onOpen={(path, create) => void switchTo(path, create).catch(() => {})}
      />
    );
  }
  return (
    <VaultContext.Provider value={context}>
      <div key={phase.info.vault ?? "dev"} className="contents">
        {children(phase.info)}
      </div>
    </VaultContext.Provider>
  );
}
