import { useCallback, useEffect, useRef, useState } from "react";
import type { components } from "@graite/api-types";
import { request } from "@/lib/api";
import {
  connections,
  contextLabel,
  KIND_LABELS,
  type Connection,
  type SavedModel,
} from "@/lib/connections";

type CatalogModel = components["schemas"]["CatalogModel"];

/** One pickable model: an installed local model or a saved remote one. */
export interface ModelOption {
  /** Stable key for lists and settings: the catalog id or the saved model id. */
  key: string;
  label: string;
  detail: string;
  kind: "local" | "saved";
  model_path?: string;
  saved_model_id?: string;
}

export interface ModelGroup {
  id: string;
  name: string;
  kind: "local" | Connection["kind"];
  options: ModelOption[];
}

export function groupModels(
  catalog: CatalogModel[],
  list: { connections: Connection[]; models: SavedModel[] },
): ModelGroup[] {
  const local: ModelGroup = {
    id: "local",
    name: KIND_LABELS.local,
    kind: "local",
    options: catalog
      .filter((m) => m.role === "chat" && m.status === "installed")
      .map((m) => ({
        key: m.id,
        label: m.name,
        detail: "",
        kind: "local",
        model_path: m.local_path,
      })),
  };
  const remote = list.connections.map<ModelGroup>((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    options: list.models
      .filter((m) => m.connection_id === c.id)
      .map((m) => ({
        key: m.id,
        label: m.label,
        detail: [m.model !== m.label ? m.model : "", contextLabel(m.context_length)]
          .filter(Boolean)
          .join(" · "),
        kind: "saved",
        saved_model_id: m.id,
      })),
  }));
  return [local, ...remote];
}

/** Every model the user can pick, grouped by where it comes from. */
export function useModelOptions(version = 0) {
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // A request can finish after the component is gone (closing a panel, a test tearing down);
  // setting state then is at best wasted and at worst throws once the DOM is torn down.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const [models, list] = await Promise.all([
        request<CatalogModel[]>("/api/v1/ai/catalog"),
        connections.list(),
      ]);
      if (!mounted.current) return;
      setCatalog(Array.isArray(models) ? models : []);
      setGroups(
        groupModels(Array.isArray(models) ? models : [], list ?? { connections: [], models: [] }),
      );
      setError("");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  return { groups, catalog, error, loading, refresh };
}

export function findOption(
  groups: ModelGroup[],
  key: string | null | undefined,
): ModelOption | null {
  if (!key) return null;
  for (const group of groups) {
    const found = group.options.find((o) => o.key === key || o.model_path === key);
    if (found) return found;
  }
  return null;
}
