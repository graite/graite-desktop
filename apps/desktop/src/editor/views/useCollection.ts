import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ConflictError, isOwnRequest, onDaemonEvent, pages, type PageDoc } from "@/lib/api";
import { pageProperties, workspace, type PageProperty } from "@/lib/workspace";
import { MediaContext } from "../media/context";
import { emptyValue, findField, mergeFields, sameName } from "./collection";

const isDirectChild = (path: string, parent: string | undefined) =>
  !parent || (path.startsWith(parent + "/") && !path.slice(parent.length + 1).includes("/"));

/** Live child pages of the current page plus the writes a view can make to them. */
const NO_FIELDS: PageProperty[] = [];

export function useCollection(defaultFields: PageProperty[] = NO_FIELDS) {
  const { pageId, pagePath, onTreeChanged } = useContext(MediaContext);
  const [rows, setRows] = useState<PageDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const reload = useCallback(async () => {
    try {
      const next = await workspace.children(pageId);
      setRows(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void reload();
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (live) void reload();
      }, 150);
    };
    const stop = onDaemonEvent((e) => {
      if (e.type === "tree_changed") schedule();
      if (e.type === "file_changed") {
        const { path, request_id } = e.data as { path: string; request_id?: string | null };
        if (!isOwnRequest(request_id) && isDirectChild(path, pagePath)) schedule();
      }
    });
    return () => {
      live = false;
      clearTimeout(timer);
      stop();
    };
  }, [reload, pagePath]);

  const fields = useMemo(() => {
    const existing = mergeFields(rows);
    return [
      ...existing,
      ...defaultFields.filter((f) => !existing.some((e) => sameName(e.name, f.name))),
    ];
  }, [rows, defaultFields]);
  const latest = (row: PageDoc) => rowsRef.current.find((r) => r.id === row.id) ?? row;
  const patch = (doc: PageDoc) =>
    setRows((rs) =>
      rs.some((r) => r.id === doc.id) ? rs.map((r) => (r.id === doc.id ? doc : r)) : [...rs, doc],
    );

  /** Write a page's full property list; on a 409 refetch that page once and apply again. */
  const write = useCallback(async (row: PageDoc, next: (current: PageDoc) => PageProperty[]) => {
    const attempt = (current: PageDoc) =>
      workspace.properties(current.id, next(current), current.hash);
    let doc: PageDoc;
    try {
      doc = await attempt(latest(row));
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      doc = await attempt(await pages.get(row.path));
    }
    patch(doc);
    return doc;
  }, []);

  /** Set one value; adds the property from the merged definition when the page lacks it. */
  const setValue = useCallback(
    (row: PageDoc, field: PageProperty, value: PageProperty["value"]) =>
      write(row, (current) => {
        const list = pageProperties(current);
        const existing = list.find((p) => sameName(p.name, field.name));
        if (!existing)
          return [
            ...list,
            {
              ...field,
              id: crypto.randomUUID(),
              options: [...field.options],
              colors: { ...field.colors },
              value,
            },
          ];
        const addOption =
          (existing.type === "status" || existing.type === "single_select") &&
          typeof value === "string" &&
          value &&
          !existing.options.includes(value);
        return list.map((p) =>
          p === existing
            ? { ...p, value, options: addOption ? [...p.options, value] : p.options }
            : p,
        );
      }),
    [write],
  );

  /** Replace one property definition (rename, options, colors) on a page. */
  const setField = useCallback(
    (row: PageDoc, next: PageProperty) =>
      write(row, (current) => pageProperties(current).map((p) => (p.id === next.id ? next : p))),
    [write],
  );

  /** Add a property to every child page that has no property with that name. */
  const addFieldToAll = useCallback(
    async (field: PageProperty) => {
      for (const row of rowsRef.current) {
        if (findField(row, field.name)) continue;
        await write(row, (current) => [
          ...pageProperties(current),
          { ...field, id: crypto.randomUUID(), value: emptyValue(field) },
        ]);
      }
    },
    [write],
  );

  const createPage = useCallback(
    async (title: string, group?: { field: PageProperty; value: string }) => {
      let doc = await pages.create({
        parentPath: pagePath || null,
        title: title.trim() || "Untitled",
      });
      const initial = fields.map((field) => ({
        ...field,
        id: crypto.randomUUID(),
        value: emptyValue(field),
      }));
      if (group) {
        const field = initial.find((f) => sameName(f.name, group.field.name));
        if (field) field.value = group.value;
        else initial.push({ ...group.field, id: crypto.randomUUID(), value: group.value });
      }
      if (initial.length) doc = await workspace.properties(doc.id, initial, doc.hash);
      patch(doc);
      onTreeChanged();
      return doc;
    },
    [pagePath, fields, onTreeChanged],
  );

  /** Reorder within the siblings (the sidebar order); optimistic locally, confirmed by the reload. */
  const reorder = useCallback(
    async (row: PageDoc, target: PageDoc, position: "before" | "after") => {
      setRows((rs) => {
        const without = rs.filter((r) => r.id !== row.id);
        const at = without.findIndex((r) => r.id === target.id);
        if (at < 0) return rs;
        without.splice(at + (position === "after" ? 1 : 0), 0, latest(row));
        return without;
      });
      await workspace.move(row.id, target.id, position);
    },
    [],
  );

  return {
    rows,
    fields,
    loading,
    error,
    setValue,
    setField,
    addFieldToAll,
    createPage,
    reorder,
    reload,
  };
}

export type Collection = ReturnType<typeof useCollection>;
