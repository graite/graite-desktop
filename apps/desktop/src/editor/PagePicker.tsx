import { PageIcon } from "@/components/PageIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { TreeNode } from "@/lib/api";
import { allPages, type FlatPage } from "./tree-utils";

interface PagePickerProps {
  open: boolean;
  tree: TreeNode[];
  /** Excluded from the list (the page being edited). */
  excludePath: string | null;
  onPick: (page: FlatPage) => void;
  onCancel: () => void;
}

/** Search-and-pick dialog for "Link to page". Keyboard: type to filter, ↑/↓, Enter, Esc. */
export function PagePicker({ open, tree, excludePath, onPick, onCancel }: PagePickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const pages = useMemo(
    () => allPages(tree).filter((p) => p.path !== excludePath),
    [tree, excludePath],
  );
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? pages.filter((p) => p.title.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      : pages;
    return list.slice(0, 50);
  }, [pages, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Link to page</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="size-4 text-muted-foreground" />
          <input
            ref={inputRef}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search pages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const r = results[active];
                if (r) onPick(r);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
          />
        </div>
        <div className="max-h-80 overflow-auto py-1">
          {results.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">No pages match.</p>
          )}
          {results.map((p, i) => (
            <button
              key={p.path}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent ${
                i === active ? "bg-accent" : ""
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(p)}
            >
              <span className="flex w-5 shrink-0 items-center justify-center">
                <PageIcon
                  icon={p.icon}
                  hasContent={p.hasContent}
                  className="size-4"
                  emojiClassName="text-base leading-none"
                />
              </span>
              <span className="truncate">{p.title}</span>
              {p.breadcrumb && (
                <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
                  {p.breadcrumb}
                </span>
              )}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
