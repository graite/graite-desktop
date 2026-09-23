import { useEffect, useState } from "react";
import { FolderOpen, FolderPlus, X } from "lucide-react";
import { platform, type VaultList, type VaultProbe } from "@/lib/platform";
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

/**
 * First launch, or no vault remembered: choose the folder Graite opens. Also used as the
 * "switch vault" dialog body, so it takes the chosen path back through `onOpen`.
 */
export function VaultPicker({
  error,
  busy,
  onOpen,
  onCancel,
}: {
  error?: string;
  busy?: boolean;
  onOpen: (path: string, create: boolean) => void;
  onCancel?: () => void;
}) {
  const [list, setList] = useState<VaultList>({ current: null, recent: [], dev: false });
  const [probes, setProbes] = useState<Record<string, VaultProbe>>({});
  const [confirm, setConfirm] = useState<{ path: string; probe: VaultProbe } | null>(null);
  const [local, setLocal] = useState("");
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
  const choose = async () => {
    setLocal("");
    const path = await platform.pickFolder?.("Open a vault folder");
    if (!path) return;
    const probe = (await platform.inspectVault?.(path)) ?? null;
    if (probe && probe.exists && !probe.is_dir) {
      setLocal("Choose a folder, not a file.");
      return;
    }
    if (probe && (probe.pages || probe.has_graite)) onOpen(path, false);
    else if (probe) setConfirm({ path, probe });
    else onOpen(path, false);
  };
  const message = local || error;
  return (
    <div className="vault-picker" role="dialog" aria-label="Choose a vault">
      <div className="vault-picker-card">
        <div className="startup-mark vault-picker-mark" aria-hidden="true" />
        <h1>Where do your notes live?</h1>
        <p>
          A vault is a folder of Markdown pages. Graite reads and writes only inside it, and the
          folder stays yours to open in any other app.
        </p>
        {message ? (
          <p className="vault-picker-error" role="alert">
            {message}
          </p>
        ) : null}
        {confirm ? (
          <div
            className="vault-picker-confirm"
            role="alertdialog"
            aria-label="Create a vault here?"
          >
            <strong>Start a new vault in {vaultName(confirm.path)}?</strong>
            <small>
              {confirm.probe.other_files
                ? "This folder already holds other files. Graite adds pages next to them and keeps its index in a .graite folder."
                : "The folder is empty. Graite adds your pages and keeps its index in a .graite folder."}
            </small>
            <div>
              <button
                type="button"
                className="vault-picker-primary"
                disabled={busy}
                onClick={() => onOpen(confirm.path, true)}
              >
                Create vault here
              </button>
              <button type="button" onClick={() => setConfirm(null)}>
                Choose another folder
              </button>
            </div>
          </div>
        ) : (
          <>
            {!!list.recent.length && (
              <ul className="vault-picker-recent" aria-label="Recent vaults">
                {list.recent.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      className="vault-picker-vault"
                      disabled={busy}
                      onClick={() => onOpen(path, false)}
                    >
                      <FolderOpen size={16} />
                      <span>
                        <strong>{vaultName(path)}</strong>
                        <small>{path}</small>
                      </span>
                      <em>{path === list.current ? "Current" : describe(probes[path])}</em>
                    </button>
                    <button
                      type="button"
                      className="vault-picker-forget"
                      aria-label={`Remove ${vaultName(path)} from the list`}
                      disabled={busy}
                      onClick={() => void platform.forgetVault?.(path).then(refresh)}
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="vault-picker-actions">
              <button
                type="button"
                className="vault-picker-primary"
                disabled={busy}
                onClick={() => void choose()}
              >
                <FolderPlus size={15} /> {busy ? "Opening…" : "Open or create a folder…"}
              </button>
              {onCancel ? (
                <button type="button" disabled={busy} onClick={onCancel}>
                  Cancel
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
