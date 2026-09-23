import { useCallback, useEffect, useRef, useState } from "react";
import { onDaemonEvent } from "@/lib/api";
import { engines, type EngineState } from "@/lib/engines";

/** One engine's state, kept current with the daemon's `engine_progress` events.
 * `onSettled` runs when an install, update or removal finishes. */
export function useEngine(engineId: "llama" | "crispasr", onSettled?: () => void) {
  const [state, setState] = useState<EngineState | null>(null);
  const [error, setError] = useState("");
  // Settings re-renders on every keystroke; keeping the callback in a ref stops the
  // subscription below from tearing down and reopening each time.
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const refresh = useCallback(async () => {
    try {
      const next = (await engines.list()).find((e) => e.id === engineId) ?? null;
      setState(next);
      setError(next ? "" : `Graite does not know an engine called “${engineId}”.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [engineId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type !== "engine_progress" || (event.data as { id?: string }).id !== engineId)
          return;
        const data = event.data as { status?: string; progress?: number; error?: string | null };
        setState((old) =>
          old
            ? {
                ...old,
                status: data.status ?? old.status,
                progress: data.progress ?? old.progress,
                error: data.error ?? null,
              }
            : old,
        );
        if (data.status === "idle" || data.status === "error") {
          void refresh();
          settled.current?.();
        }
      }),
    [engineId, refresh],
  );
  return { state, error, refresh, setState };
}
