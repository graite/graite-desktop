import { useEffect, useState } from "react";
import { mail } from "@/lib/mail";
import { platform } from "@/lib/platform";
import { vaultName } from "@/lib/storage";

interface Known {
  path: string;
  /** What the vault is called where it syncs with other devices; null when it does not. */
  synced: string | null;
}

/**
 * Where a mailbox is shown: in every vault on this computer (the default), or only in the
 * vaults ticked here, for example the ones that sync or the one for work.
 */
export function VaultChoice({
  value,
  onChange,
}: {
  /** The vault folders the mailbox is kept to; empty means every vault. */
  value: string[];
  onChange: (vaults: string[]) => void;
}) {
  const [here, setHere] = useState("");
  const [known, setKnown] = useState<Known[]>([]);
  const [limited, setLimited] = useState(value.length > 0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const current = (await mail.accounts().catch(() => null))?.vault ?? "";
      const list = await platform.vaults?.().catch(() => null);
      const paths = [
        ...new Set([current, list?.current ?? "", ...(list?.recent ?? []), ...value]),
      ].filter(Boolean);
      const found = await Promise.all(
        paths.map(async (path) => {
          const probe = await platform.inspectVault?.(path).catch(() => null);
          return { path, synced: probe?.synced ?? null };
        }),
      );
      if (!live) return;
      setHere(current);
      setKnown(found);
    })();
    return () => {
      live = false;
    };
    // The list of vaults is read once, when the dialog opens.
  }, []);

  const toggle = (path: string) =>
    onChange(value.includes(path) ? value.filter((p) => p !== path) : [...value, path]);
  const syncing = known.filter((vault) => vault.synced);

  return (
    <fieldset className="grid gap-2 text-sm">
      <legend className="mb-1.5">Show this mailbox in</legend>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="mail-vaults"
          className="accent-foreground"
          checked={!limited}
          onChange={() => {
            setLimited(false);
            onChange([]);
          }}
        />
        Every vault on this computer
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="mail-vaults"
          className="accent-foreground"
          checked={limited}
          onChange={() => {
            setLimited(true);
            // Start from where you are: this vault keeps the mailbox unless you untick it.
            if (!value.length && here) onChange([here]);
          }}
        />
        Only the vaults I choose
      </label>
      {limited && (
        <div className="ml-6 grid gap-1.5">
          {known.map((vault) => (
            <label key={vault.path} className="flex items-start gap-2" title={vault.path}>
              <input
                type="checkbox"
                className="mt-1 accent-foreground"
                checked={value.includes(vault.path)}
                onChange={() => toggle(vault.path)}
              />
              <span className="min-w-0">
                <span className="block truncate">
                  {vaultName(vault.path)}
                  {vault.path === here && (
                    <span className="text-muted-foreground"> · this vault</span>
                  )}
                  {vault.synced && <span className="text-muted-foreground"> · syncs</span>}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{vault.path}</span>
              </span>
            </label>
          ))}
          {syncing.length > 0 && (
            <button
              type="button"
              className="justify-self-start text-xs text-muted-foreground underline"
              onClick={() => onChange(syncing.map((vault) => vault.path))}
            >
              Only the vaults that sync
            </button>
          )}
          {here && !value.includes(here) && (
            <p className="text-xs text-muted-foreground">
              It leaves this vault when you save: its mail is no longer kept here. The mailbox
              itself and your drafts stay.
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
