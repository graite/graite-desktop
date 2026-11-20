import { useCallback, useEffect, useRef, useState } from "react";
import { compute, type ComputeStatus } from "@/lib/compute";

const POLL_MS = 15_000;

/** Your other computers that do AI work for this one (and whether this one does it for
 * them). Looked up when `version` changes, and with `poll` every so often as well. */
export function useWorkstations(version = 0, poll = true) {
  const [status, setStatus] = useState<ComputeStatus | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await compute.status();
      if (mounted.current) setStatus(next);
    } catch {
      // The daemon is restarting or sync is off: keep what was shown.
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = poll ? window.setInterval(() => void refresh(), POLL_MS) : null;
    return () => {
      mounted.current = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [refresh, version, poll]);
  return { status, refresh, setStatus };
}
