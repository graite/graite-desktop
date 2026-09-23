import { useEffect, useState } from "react";
import { FolderOpen, FolderSearch, HardDrive } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useVault } from "@/app/vault-context";
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
  const switchVault = async () => {
    if (!vault?.canSwitch) return;
    const picked = await vault.pickFolder();
    if (!picked) return;
    setBusy(true);
    try {
      await vault.switchTo(picked, false);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <section className="ai-utilities" aria-label="Vault">
      <div className="ai-section-heading">
        <h2>Vault</h2>
        <span>Your notes on disk</span>
      </div>
      <div className="ai-vault-card">
        <HardDrive size={20} />
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
              <FolderOpen size={14} /> {busy ? "Switching…" : "Switch vault…"}
            </Button>
          ) : vault?.info.dev ? (
            <small>Managed by the dev daemon</small>
          ) : null}
        </div>
      </div>
    </section>
  );
}
