/**
 * Per-vault browser storage. The desktop app can switch vaults without reloading, and a
 * remembered page path or expanded folder from one vault means nothing in another, so
 * vault-specific keys are suffixed with a hash of the vault path.
 */
let scope = "";

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Call once the vault is known (and again after a switch). Null or "" means unscoped. */
export function setStorageScope(vault: string | null | undefined): void {
  scope = vault ? hash(vault) : "";
}

/** `graite.selectedPath` becomes `graite.selectedPath:1a2b3c` for the current vault. */
export function scopedKey(base: string): string {
  return scope ? `${base}:${scope}` : base;
}

/** The last path segment of a vault folder, for titles. */
export function vaultName(path: string | null | undefined): string {
  if (!path) return "Graite";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
