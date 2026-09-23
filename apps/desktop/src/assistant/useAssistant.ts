import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { onDaemonEvent } from "@/lib/api";
import { assistant, type AssistantInfo } from "@/lib/assistant";

/** The assistant's state, refreshed when its definition, memory pages or policy change. */
export function useAssistant() {
  const [info, updateInfo] = useState<AssistantInfo | null>(null);
  const generation = useRef(0);
  const setInfo = useCallback((next: SetStateAction<AssistantInfo | null>) => {
    generation.current += 1;
    updateInfo(next);
  }, []);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await assistant.get();
      if (request === generation.current) {
        updateInfo(next);
        setError("");
      }
    } catch (e) {
      if (request === generation.current) setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type === "policy_changed" || event.type === "tree_changed") void refresh();
      }),
    [refresh],
  );
  return { info, setInfo, error, refresh };
}
