import { useEffect, useState } from "react";
import { onDaemonEvent } from "@/lib/api";

/** Pages written since this view opened, so a cited passage can be marked as stale. */
export function useChangedPages(): Set<string> {
  const [changed, setChanged] = useState<Set<string>>(new Set());
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type !== "file_changed") return;
        const path = (event.data as { path?: string }).path;
        if (path) setChanged((old) => (old.has(path) ? old : new Set(old).add(path)));
      }),
    [],
  );
  return changed;
}
