import { useEffect, useState } from "react";
import { FolderOpen, FolderSearch, HardDrive } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useVault } from "@/app/vault-context";
import { VaultList } from "@/app/VaultList";
import { api, type Health } from "@/lib/api";
import { vaultName } from "@/lib/storage";
import "@/app/vault.css";

/** Where this vault lives, how much is in it, and the way to another one. */
export function VaultCard() {
  const vault = useVault();
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  const path = vault?.info.vault ?? health?.vault ?? null;
  if (!path) return null;
  const open = async (picked: string) => {
    if (!vault?.canSwitch) return;
    setBusy(true);
    try {
      await vault.switchTo(picked, false);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  const switchVault = async () => {
    const picked = await vault?.pickFolder();
    if (picked) await open(picked);
  };
  return (
    <section className="settings-card" aria-label="Vault">
      <h2>Vault</h2>
      <p>The folder on this computer that holds your pages, as plain Markdown files.</p>
      <div className="ai-vault-card">
        <HardDrive size={18} />
        <div>
          <strong>{vaultName(path)}</strong>
          <small title={path}>{path}</small>
          {health ? (
            <small>
              {health.pages} page{health.pages === 1 ? "" : "s"}
              {health.is_new ? " · new vault" : ""}
            </small>
          ) : null}
        </div>
        <div className="ai-vault-card-actions">
          {vault ? (
            <Button variant="ghost" size="sm" onClick={() => void vault.reveal(path)}>
              <FolderSearch size={14} /> Reveal
            </Button>
          ) : null}
          {vault?.canSwitch ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void switchVault()}>
              <FolderOpen size={14} /> {busy ? "Switching…" : "Open another folder…"}
            </Button>
          ) : vault?.info.dev ? (
            <small>Managed by the dev daemon</small>
          ) : null}
        </div>
      </div>
      {vault?.canSwitch && (
        <>
          <h3 className="vault-list-title">Your vaults on this computer</h3>
          <VaultList busy={busy} current={path} onOpen={(next) => void open(next)} />
        </>
      )}
    </section>
  );
}
