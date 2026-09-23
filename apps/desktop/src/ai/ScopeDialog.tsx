import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Minus, Search, X } from "lucide-react";
import { PageIcon } from "@/components/PageIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { TreeNode } from "@/lib/api";
import type { Scope } from "@/lib/ai";
import {
  allPaths,
  checkedFromScope,
  countSelected,
  normalizeSelection,
  stateOf,
  toggle,
  type CheckState,
} from "@/lib/scope";

const STATE_LABEL: Record<CheckState, string> = {
  checked: "true",
  mixed: "mixed",
  unchecked: "false",
};

function Row({
  node,
  depth,
  checked,
  open,
  query,
  onToggleOpen,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  checked: Set<string>;
  open: Set<string>;
  query: string;
  onToggleOpen: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const state = stateOf(node, checked);
  const matches = (n: TreeNode): boolean =>
    !query ||
    n.title.toLowerCase().includes(query) ||
    n.path.toLowerCase().includes(query) ||
    n.children.some(matches);
  if (!matches(node)) return null;
  const expanded = open.has(node.path) || !!query;
  return (
    <>
      <div className="ai-scope-row" style={{ paddingLeft: depth * 16 + 8 }}>
        <button
          type="button"
          className="ai-scope-twisty"
          aria-label={expanded ? `Collapse ${node.title}` : `Expand ${node.title}`}
          data-hidden={!node.children.length || undefined}
          tabIndex={node.children.length ? 0 : -1}
          aria-expanded={node.children.length ? expanded : undefined}
          onClick={() => onToggleOpen(node.path)}
        >
          <ChevronRight size={13} style={{ transform: expanded ? "rotate(90deg)" : undefined }} />
        </button>
        <button
          type="button"
          role="checkbox"
          aria-checked={STATE_LABEL[state] as "true" | "false" | "mixed"}
          aria-label={node.title}
          className="ai-scope-option"
          onClick={() => onToggle(node.path)}
        >
          <span className="ai-scope-check" data-state={state}>
            {state === "checked" ? (
              <Check size={12} />
            ) : state === "mixed" ? (
              <Minus size={12} />
            ) : null}
          </span>
          <PageIcon
            icon={node.icon}
            hasContent={node.has_content}
            className="size-4 shrink-0"
            emojiClassName="text-sm leading-none"
          />
          <span className="ai-scope-title" title={node.title}>
            {node.title}
          </span>
          {!!node.children.length && (
            <span className="ai-scope-child-count" aria-hidden="true">
              {allPaths(node.children).length}
            </span>
          )}
        </button>
      </div>
      {expanded &&
        node.children.map((child) => (
          <Row
            key={child.path}
            node={child}
            depth={depth + 1}
            checked={checked}
            open={open}
            query={query}
            onToggleOpen={onToggleOpen}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

/** Pick which pages the Graite AI page may use. Defaults to every page. */
export function ScopeDialog({
  open,
  tree,
  scope,
  onApply,
  onCancel,
}: {
  open: boolean;
  tree: TreeNode[];
  scope: Scope;
  onApply: (scope: Scope) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => checkedFromScope(tree, scope));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) {
      setChecked(checkedFromScope(tree, scope));
      setQuery("");
      setSearchOpen(false);
    }
  }, [open, tree, scope]);
  const count = useMemo(() => countSelected(tree, checked), [tree, checked]);
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    searchButton.current?.focus();
  };
  const needle = query.trim().toLowerCase();
  const hasResults = (nodes: TreeNode[]): boolean =>
    nodes.some(
      (node) =>
        node.title.toLowerCase().includes(needle) ||
        node.path.toLowerCase().includes(needle) ||
        hasResults(node.children),
    );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="ai-scope-dialog gap-0 border-0 p-0 sm:max-w-2xl">
        <div className="ai-scope-heading">
          <DialogTitle>Pages</DialogTitle>
          <DialogDescription>
            Select the pages Studio can use. Nested pages are included automatically.
          </DialogDescription>
        </div>
        <div className="ai-scope-toolbar">
          <span className="ai-scope-count" aria-live="polite">
            {count.selected} of {count.total} pages
          </span>
          <div className="ai-scope-search" data-expanded={searchOpen || undefined}>
            <button
              ref={searchButton}
              type="button"
              aria-label="Search pages"
              aria-expanded={searchOpen}
              title="Search pages"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={16} />
            </button>
            {searchOpen && (
              <>
                <input
                  autoFocus
                  placeholder="Search pages…"
                  aria-label="Search pages"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      closeSearch();
                    }
                  }}
                />
                <button type="button" aria-label="Close search" onClick={closeSearch}>
                  <X size={14} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="ai-scope-pages" aria-label="Available pages">
          {tree.map((node) => (
            <Row
              key={node.path}
              node={node}
              depth={0}
              checked={checked}
              open={expanded}
              query={needle}
              onToggleOpen={(path) =>
                setExpanded((old) => {
                  const next = new Set(old);
                  if (!next.delete(path)) next.add(path);
                  return next;
                })
              }
              onToggle={(path) => setChecked((old) => toggle(tree, old, path))}
            />
          ))}
          {!tree.length && <p className="ai-scope-empty">No pages yet.</p>}
          {!!tree.length && !hasResults(tree) && (
            <p className="ai-scope-empty">No pages match “{query.trim()}”.</p>
          )}
        </div>
        <div className="ai-scope-footer">
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setChecked(new Set(allPaths(tree)))}>
              Select all
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())}>
              Clear
            </Button>
          </div>
          <Button
            size="sm"
            disabled={!count.selected}
            onClick={() => onApply(normalizeSelection(tree, checked))}
          >
            Use these pages
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
