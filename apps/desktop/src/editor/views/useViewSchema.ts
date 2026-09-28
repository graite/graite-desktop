import { useEffect, useState } from "react";
import { toBlocks } from "@graite/md-convert";
import { onDaemonEvent, pages, type TreeNode } from "@/lib/api";
import { workspace, type PageProperty } from "@/lib/workspace";
import { mergeFields, sameName } from "./collection";
import { readSettings } from "./settings";

const NONE: PageProperty[] = [];

/** The property definitions a view's pages share, from the view's settings and the pages. */
export function viewSchema(parentBody: string, siblings: Parameters<typeof mergeFields>[0]) {
  const defaults = (toBlocks(parentBody) as { type: string; props?: { settings?: string } }[])
    .filter((b) => b.type === "pageView")
    .flatMap((b) => readSettings(b.props?.settings).fields ?? []);
  const merged = mergeFields(siblings);
  return [...merged, ...defaults.filter((d) => !merged.some((m) => sameName(m.name, d.name)))];
}

/**
 * For a page that is an entry of a view (its parent holds a board, table or list): every
 * property the view's pages use, so the page can offer the ones it has no value for yet.
 * Empty for any other page.
 */
export function useViewSchema(parent: TreeNode | null, pageHash: string): PageProperty[] {
  const [schema, setSchema] = useState<PageProperty[]>(NONE);
  const parentId = parent?.has_view ? parent.id : null;
  const parentPath = parent?.path ?? null;
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!parentId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onDaemonEvent((e) => {
      const path = (e.data as { path?: string } | undefined)?.path;
      if (e.type === "tree_changed" || (parentPath && path?.startsWith(parentPath + "/"))) {
        clearTimeout(timer);
        timer = setTimeout(() => setVersion((v) => v + 1), 200);
      }
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [parentId, parentPath]);
  useEffect(() => {
    if (!parentId || !parentPath) {
      setSchema(NONE);
      return;
    }
    let live = true;
    void Promise.all([pages.get(parentPath), workspace.children(parentId)])
      .then(([doc, siblings]) => {
        if (live) setSchema(viewSchema(doc.body, siblings));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [parentId, parentPath, pageHash, version]);
  return schema;
}
