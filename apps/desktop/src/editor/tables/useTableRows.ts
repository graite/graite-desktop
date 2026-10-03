import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isOwnRequest, onDaemonEvent } from "@/lib/api";
import { tables, type RowsPage, type RowsQuery, type TableRow } from "@/lib/tables";

/** Rows are fetched in pages as the grid scrolls; filter, sort and paging run in SQL. */
export const PAGE_SIZE = 200;

export type TableMeta = Omit<RowsPage, "rows" | "offset">;

/**
 * A windowed view of one table for one query. Pages load on demand (`ensure`), stay cached
 * while the query is the same, and are refetched when the table changes outside this block,
 * or when a table it links to or from changes (labels and reverse columns live there).
 */
export function useTableRows(path: string | null, query: Omit<RowsQuery, "offset" | "limit">) {
  const [meta, setMeta] = useState<TableMeta | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const pages = useRef(new Map<number, TableRow[]>());
  const pending = useRef(new Set<number>());
  // Responses for an earlier query or table are dropped when they arrive late.
  const generation = useRef(0);
  const key = useMemo(() => JSON.stringify(query), [query]);

  const fetchPage = useCallback(
    async (index: number, gen: number) => {
      if (!path || pending.current.has(index)) return;
      pending.current.add(index);
      try {
        const page = await tables.rows(path, {
          ...(JSON.parse(key) as RowsQuery),
          offset: index * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        if (gen !== generation.current) return;
        const { rows, ...rest } = page;
        pages.current.set(index, rows);
        setMeta(rest);
        setError("");
        setVersion((v) => v + 1);
      } catch (e) {
        if (gen === generation.current) setError((e as Error).message);
      } finally {
        pending.current.delete(index);
      }
    },
    [path, key],
  );

  /** Refetch what is loaded (or the first page), keeping old rows on screen meanwhile. */
  const reload = useCallback(() => {
    const gen = ++generation.current;
    pending.current.clear();
    const loaded = pages.current.size ? [...pages.current.keys()] : [0];
    for (const index of loaded) void fetchPage(index, gen);
  }, [fetchPage]);

  useEffect(() => {
    pages.current = new Map();
    setMeta(null);
    setError("");
    reload();
  }, [reload]);

  const related = useRef(new Set<string>());
  // When this block last wrote its own table: only those echoes are skipped. A write from
  // another block, the row panel or a reverse edit in another table is this webview's too,
  // yet changes what this block shows.
  const wroteAt = useRef(0);
  const expectOwn = useCallback(() => {
    wroteAt.current = Date.now();
  }, []);
  useEffect(() => {
    related.current = new Set(
      (meta?.columns ?? []).map((c) => c.target).filter((t): t is string => !!t && t !== path),
    );
  }, [meta, path]);

  useEffect(() => {
    if (!path) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onDaemonEvent((e) => {
      if (e.type !== "table_changed") return;
      const data = e.data as { path?: string; request_id?: string | null };
      // A linked table's change is never "ours" for this block: its labels or reverse
      // links may have changed through an edit made in another block.
      const linked = !!data.path && related.current.has(data.path);
      const echo = isOwnRequest(data.request_id) && Date.now() - wroteAt.current < 3000;
      if (!linked && (data.path !== path || echo)) return;
      clearTimeout(timer);
      timer = setTimeout(reload, 150);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [path, reload]);

  const ensure = useCallback(
    (first: number, last: number) => {
      const from = Math.floor(Math.max(0, first) / PAGE_SIZE);
      const to = Math.floor(Math.max(0, last) / PAGE_SIZE);
      for (let index = from; index <= to; index++)
        if (!pages.current.has(index)) void fetchPage(index, generation.current);
    },
    [fetchPage],
  );

  const row = useCallback(
    (index: number): TableRow | undefined =>
      pages.current.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE],
    // `version` makes a new function when pages arrive, so the grid redraws.
    [version],
  );

  /** Show an edit before the daemon confirms it. */
  const patch = useCallback((id: string, cell: number, value: unknown) => {
    for (const rows of pages.current.values()) {
      const target = rows.find((r) => r.id === id);
      if (target) {
        const cells = [...target.cells];
        cells[cell] = value;
        rows[rows.indexOf(target)] = { ...target, cells };
      }
    }
    setVersion((v) => v + 1);
  }, []);

  return { meta, error, row, ensure, reload, patch, expectOwn };
}
