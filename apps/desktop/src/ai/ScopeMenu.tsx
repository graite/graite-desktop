import { useMemo } from "react";
import { Ban, Check, ChevronDown, File, Files, FolderTree, ListChecks } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TreeNode } from "@/lib/api";
import type { Scope } from "@/lib/ai";
import { ALL_PAGES, NO_PAGES, checkedFromScope, countSelected, scopeLabel } from "@/lib/scope";

type Choice = "all" | "page" | "subpages" | "chosen" | "none";

function choiceOf(scope: Scope, page?: string): Choice {
  if (scope.kind === "none") return "none";
  if (scope.kind === "vault") return scope.roots.length || scope.excluded.length ? "chosen" : "all";
  // A page or folder scope that is not this page's own is a chosen set like any other.
  if (!page || scope.roots[0] !== page || scope.excluded.length) return "chosen";
  return scope.kind === "page" ? "page" : "subpages";
}

/** Which pages the AI may use in this chat, shown in the message box. With every page selected the AI still works from the search index and
 * only opens the pages it needs. */
export function ScopeMenu({
  scope,
  tree,
  page,
  onChange,
  onChoose,
  disabled,
  indexing = 0,
}: {
  scope: Scope;
  tree: TreeNode[];
  /** The page this chat belongs to, when it is a page's chat. */
  page?: string;
  onChange: (scope: Scope) => void;
  /** Open the page tree to pick a set of pages. */
  onChoose: () => void;
  disabled?: boolean;
  /** Sections still waiting to be indexed. */
  indexing?: number;
}) {
  const choice = choiceOf(scope, page);
  const label = useMemo(
    () => scopeLabel(scope, countSelected(tree, checkedFromScope(tree, scope)), page),
    [scope, tree, page],
  );
  const item = (
    key: Choice,
    Icon: typeof Files,
    title: string,
    hint: string,
    onSelect: () => void,
  ) => (
    <DropdownMenuItem key={key} onSelect={onSelect}>
      <Icon size={16} />
      <span className="flex-1">
        <span className="block">{title}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      {choice === key && <Check size={14} />}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ai-scope-menu"
          aria-label={`Pages the AI can use: ${label}`}
          title="Pages the AI can use"
          data-none={choice === "none" || undefined}
          disabled={disabled}
        >
          {choice === "none" ? <Ban size={12} /> : <Files size={12} />}
          <span>{label}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-72">
        {item(
          "all",
          Files,
          "All pages",
          indexing > 0
            ? `Still indexing ${indexing} sections; answers improve as it finishes`
            : "Searches your whole workspace and opens only what it needs",
          () => onChange(ALL_PAGES),
        )}
        {page &&
          item("subpages", FolderTree, "This page & subpages", "Only this page and below", () =>
            onChange({ kind: "folder", roots: [page], excluded: [] }),
          )}
        {page &&
          item("page", File, "This page", "Only the page you are on", () =>
            onChange({ kind: "page", roots: [page], excluded: [] }),
          )}
        {item(
          "chosen",
          ListChecks,
          "Choose pages…",
          choice === "chosen" ? label : "Pick the pages yourself",
          onChoose,
        )}
        <DropdownMenuSeparator />
        {item("none", Ban, "Deselect all", "Answer without your pages", () => onChange(NO_PAGES))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
