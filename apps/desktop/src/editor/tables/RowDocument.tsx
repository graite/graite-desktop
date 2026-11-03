import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, pages, type TreeNode } from "@/lib/api";
import { tables } from "@/lib/tables";
import { MarkdownEditor } from "../MarkdownEditor";

const SAVE_AFTER_MS = 600;
let tree: Promise<TreeNode[]> | null = null;

/**
 * A row's own document (D80): `<page>/_data/<table>/<row id>.md`, written with the page
 * editor. Made on the first save; saved a moment after typing stops, against the hash it
 * loaded, so a change made elsewhere is a conflict instead of being overwritten.
 */
export function RowDocument({
  table,
  id,
  title,
  onNavigate,
}: {
  table: string;
  id: string;
  /** The row's name, kept in the file for Obsidian. */
  title: string;
  onNavigate?: (path: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ body: string; key: string } | null>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const hash = useRef("");
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const key = `${table}#${id}`;
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    let live = true;
    tree ??= pages.tree().finally(() => setTimeout(() => (tree = null), 10_000));
    void tree.then((t) => live && setNodes(t)).catch(() => {});
    tables
      .rowDoc(table, id)
      .then((doc) => {
        if (!live) return;
        hash.current = doc.hash;
        setLoaded({ body: doc.body, key });
      })
      .catch((e: Error) => live && toast.error(e.message));
    return () => {
      live = false;
    };
  }, [table, id, key]);

  const save = async () => {
    const body = pending.current;
    if (body === null) return;
    pending.current = null;
    try {
      const doc = await tables.writeRowDoc(table, id, body, hash.current, titleRef.current);
      hash.current = doc.hash;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error("This document changed elsewhere. It was reloaded.");
        const doc = await tables.rowDoc(table, id);
        hash.current = doc.hash;
        setLoaded({ body: doc.body, key: `${key}#${doc.hash}` });
      } else toast.error((e as Error).message);
    }
  };
  // Leaving saves what was typed.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      void save();
    },
    [table, id],
  );

  if (!loaded || !loaded.key.startsWith(key))
    return <div className="table-row-doc-empty">Loading…</div>;
  return (
    <div className="table-row-doc">
      <MarkdownEditor
        key={loaded.key}
        className="table-row-doc-editor"
        hint=""
        value={loaded.body}
        tree={nodes}
        onNavigate={(path) => onNavigate?.(path)}
        onChange={(body) => {
          pending.current = body;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(), SAVE_AFTER_MS);
        }}
      />
    </div>
  );
}
