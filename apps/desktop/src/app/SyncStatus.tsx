import { useEffect, useState } from "react";
import { sync, type SyncStatus as Status } from "@/lib/sync";

const POLL_MS = 10_000;

/** Ask the workspace to open Settings → Sync devices. */
export function openSyncSettings() {
  window.dispatchEvent(new CustomEvent("graite:open-settings", { detail: "sync" }));
}

// One poller for everything that shows sync outside Settings, however many places do.
let latest: Status | null = null;
let timer: number | null = null;
const listeners = new Set<(status: Status | null) => void>();

function poll() {
  sync
    .status()
    .then((next) => {
      latest = next;
      for (const listener of listeners) listener(next);
    })
    .catch(() => {});
}

/** Sync as the sidebar and the vault menu show it; polled while one of them is on screen. */
export function useSyncStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(latest);
  useEffect(() => {
    listeners.add(setStatus);
    if (timer === null) {
      poll();
      timer = window.setInterval(poll, POLL_MS);
    }
    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0 && timer !== null) {
        window.clearInterval(timer);
        timer = null;
        latest = null;
      }
    };
  }, []);
  return status;
}

/** What sync is doing, in a word or two. Null when this vault does not sync. */
export function syncLine(
  status: Status | null,
): { text: string; tone: "ok" | "busy" | "off" | "warn" } | null {
  if (!status?.space_id) return null;
  if (status.error) return { text: "Sync needs attention", tone: "warn" };
  if (!status.connected) return { text: "Sync offline", tone: "off" };
  if (status.waiting > 0)
    return {
      text: `Syncing ${status.waiting} change${status.waiting === 1 ? "" : "s"}…`,
      tone: "busy",
    };
  return { text: "Synced", tone: "ok" };
}

const DOT = {
  ok: "bg-green-500",
  busy: "bg-blue-500 animate-pulse",
  off: "bg-neutral-400",
  warn: "bg-amber-500",
};

/** One line in the sidebar footer: whether this vault is in step with your other devices.
 * A click opens Settings → Sync devices. Nothing is shown for a vault that does not sync. */
export function SyncStatus() {
  const status = useSyncStatus();
  const line = syncLine(status);
  if (!line) return null;
  return (
    <button
      type="button"
      onClick={openSyncSettings}
      title={status?.error ?? "Open Sync devices"}
      className="flex w-full items-center gap-2 rounded px-0 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
    >
      <span className={`inline-block size-2 shrink-0 rounded-full ${DOT[line.tone]}`} />
      <span className="truncate">{line.text}</span>
    </button>
  );
}
