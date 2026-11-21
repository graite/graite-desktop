import { useEffect, useState } from "react";
import { FolderOpen, MonitorSmartphone, X } from "lucide-react";
import { platform, type VaultList as Vaults, type VaultProbe } from "@/lib/platform";
import { vaultName } from "@/lib/storage";
import "./vault.css";

function describe(probe: VaultProbe | undefined): string {
  if (!probe) return "";
  if (!probe.exists) return "Folder not found";
  if (!probe.is_dir) return "Not a folder";
  if (probe.pages) return `${probe.pages} page${probe.pages === 1 ? "" : "s"}`;
  if (probe.has_graite) return "Empty vault";
  return probe.other_files ? "Folder with other files" : "Empty folder";
}

/** The vaults this computer remembers, each looked at as it is on disk now. */
export function useVaultList() {
  const [list, setList] = useState<Vaults>({ current: null, recent: [], dev: false });
  const [probes, setProbes] = useState<Record<string, VaultProbe>>({});
  const refresh = () => {
    void platform.vaults?.().then(async (next) => {
      setList(next);
      const entries = await Promise.all(
        next.recent.map(async (path) => [path, await platform.inspectVault?.(path)] as const),
      );
      setProbes(Object.fromEntries(entries.filter(([, p]) => p) as [string, VaultProbe][]));
    });
  };
  useEffect(refresh, []);
  return { list, probes, refresh };
}

/** A small mark for a vault that syncs with your other devices. */
export function SyncedBadge({ name }: { name?: string | null }) {
  return (
    <span className="vault-synced" title={name ? `Synced as ${name}` : "Synced"}>
      <MonitorSmartphone size={11} /> Synced
    </span>
  );
}

/**
 * The vaults used on this computer: name, folder, how many pages, and whether each syncs
 * with your other devices. A click opens one; the cross takes it off the list (the folder
 * itself is never touched).
 */
export function VaultList({
  busy,
  onOpen,
  current,
}: {
  busy?: boolean;
  onOpen: (path: string) => void;
  /** The vault that is open now; it is shown, not offered. Absent on the first-launch picker. */
  current?: string | null;
}) {
  const { list, probes, refresh } = useVaultList();
  if (!list.recent.length) return null;
  return (
    <ul className="vault-picker-recent" aria-label="Vaults on this computer">
      {list.recent.map((path) => {
        const probe = probes[path];
        return (
          <li key={path}>
            <button
              type="button"
              className="vault-picker-vault"
              disabled={busy || path === current}
              aria-current={path === current ? "true" : undefined}
              onClick={() => onOpen(path)}
            >
              <FolderOpen size={16} />
              <span>
                <strong>
                  {vaultName(path)}
                  {probe?.synced != null && <SyncedBadge name={probe.synced} />}
                </strong>
                <small>{path}</small>
              </span>
              <em>
                {path === current
                  ? "Open now"
                  : !current && path === list.current
                    ? "Current"
                    : describe(probe)}
              </em>
            </button>
            {path !== current && (
              <button
                type="button"
                className="vault-picker-forget"
                aria-label={`Remove ${vaultName(path)} from the list`}
                disabled={busy}
                onClick={() => void platform.forgetVault?.(path).then(refresh)}
              >
                <X size={13} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
