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

/** Sync as the vault menu shows it; polled while it is on screen. */
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
