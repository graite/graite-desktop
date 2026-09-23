import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageEditor } from "@/editor/PageEditor";
import { isOwnRequest, onDaemonEvent, pages, type PageDoc, type TreeNode } from "@/lib/api";

/** Assistant-owned documents use the same editor and save/conflict handling as other pages. */
export function AssistantPage({
  path,
  tree,
  onNavigate,
  onChanged,
  registerFlush,
}: {
  path: string;
  tree: TreeNode[];
  onNavigate: (path: string) => void;
  onChanged: () => void;
  registerFlush: (flush: (() => Promise<void>) | null) => void;
}) {
  const [page, setPage] = useState<PageDoc | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const current = useRef(page);
  current.current = page;
  useEffect(() => {
    let live = true;
    setPage(null);
    setError("");
    void pages
      .get(path)
      .then((p) => {
        if (live) setPage(p);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [path]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        const data = event.data as { path?: string; request_id?: string };
        if (
          !current.current ||
          event.type !== "file_changed" ||
          data.path !== current.current?.path ||
          isOwnRequest(data.request_id)
        )
          return;
        const target = current.current.path;
        void pages
          .get(target)
          .then((p) => {
            if (current.current?.path === target) {
              setPage(p);
              setNonce((n) => n + 1);
            }
          })
          .catch((e: Error) => toast.error(e.message));
      }),
    [],
  );
  useEffect(() => {
    const find = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const node of nodes) {
        if (node.id === current.current?.id) return node;
        const found = find(node.children);
        if (found) return found;
      }
    };
    const node = find(tree);
    if (node && node.path !== current.current?.path)
      setPage((p) => p && { ...p, path: node.path, title: node.title });
  }, [tree]);
  const renamed = useCallback(
    (_old: string, next: string) => {
      setPage((p) => p && { ...p, path: next });
      onChanged();
    },
    [onChanged],
  );
  if (error)
    return (
      <p role="alert" className="ai-notice ai-error">
        {error}
      </p>
    );
  if (!page) return <p className="assistant-muted">Loading page…</p>;
  return (
    <PageEditor
      page={page}
      tree={tree}
      refreshNonce={nonce}
      registerFlush={registerFlush}
      onNavigate={onNavigate}
      onTitleChange={(title) => setPage((p) => p && { ...p, title })}
      onIconChange={(icon) => setPage((p) => p && { ...p, icon })}
      onRenamed={renamed}
      onTreeChanged={onChanged}
      onSaved={(hash) => setPage((p) => p && { ...p, hash })}
    />
  );
}
