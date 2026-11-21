import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { request, connectEvents } from "@/lib/api";
import type { components } from "@graite/api-types";

export type Model = components["schemas"]["CatalogModel"];

/** The daemon's model catalog, kept current with download progress. */
export function useCatalog() {
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState("");
  // What each model's error was at the last look, to say a new failure once as a popup.
  // Null until the first list has arrived: failures from before are only shown on the card.
  const failures = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      request<Model[]>("/api/v1/ai/catalog")
        .then((m) => {
          if (!live) return;
          const now = new Map(m.filter((x) => x.error).map((x) => [x.id, x.error as string]));
          for (const [id, message] of now) {
            if (failures.current && failures.current.get(id) !== message) {
              const name = m.find((x) => x.id === id)?.name ?? "The model";
              // The id keeps it to one popup when more than one list is on screen.
              toast.error(`${name}: ${message}`, { id: `model-failed-${id}` });
            }
          }
          failures.current = now;
          setModels(m);
        })
        .catch((e: Error) => {
          if (live) setError(e.message);
        });
    void refresh();
    const unsubscribe = connectEvents((e) => {
      if (e.type === "model_progress") void refresh();
    });
    // Reconcile after reconnect, including downloads that finished while the UI was closed.
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  /** Run a catalog action (download, pause, remove) and keep the list in step. */
  const act = async (id: string, action: string) => {
    setError("");
    const updated = await request<Model>(`/api/v1/ai/catalog/${id}/${action}`, {
      method: "POST",
    });
    if (action === "remove" && updated.source === "local")
      setModels((items) => items.filter((m) => m.id !== id));
    else setModels((items) => items.map((m) => (m.id === id ? updated : m)));
    return updated;
  };
  const reload = async () => setModels(await request<Model[]>("/api/v1/ai/catalog"));
  return { models, setModels, error, setError, act, reload };
}
