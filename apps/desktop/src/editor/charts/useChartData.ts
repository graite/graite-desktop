import { useCallback, useEffect, useRef, useState } from "react";
import { onDaemonEvent } from "@/lib/api";
import { charts, type ChartData, type ChartSpec } from "@/lib/charts";

/** A chart's data, fetched again when the spec changes or one of its tables does. */
export function useChartData(pagePath: string | null, spec: ChartSpec | null) {
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const key = spec ? JSON.stringify(spec) : "";
  const tables = useRef(new Set<string>());

  useEffect(() => {
    if (!pagePath || !key) return;
    const abort = new AbortController();
    charts
      .data(pagePath, JSON.parse(key) as ChartSpec, abort.signal)
      .then((d) => {
        tables.current = new Set(d.tables ?? []);
        setData(d);
        setError("");
      })
      .catch((e: Error) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [pagePath, key, version]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onDaemonEvent((e) => {
      if (e.type !== "table_changed") return;
      const path = (e.data as { path?: string }).path;
      if (!path || !tables.current.has(path)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((v) => v + 1), 200);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, reload };
}
