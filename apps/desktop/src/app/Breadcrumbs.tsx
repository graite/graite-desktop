import { PageIcon } from "@/components/PageIcon";
import type { TreeNode } from "@/lib/api";
import { findNode } from "@/editor/tree-utils";

interface BreadcrumbsProps {
  path: string;
  tree: TreeNode[];
  onNavigate: (path: string) => void;
}

/** Ancestor chain derived from the page path; titles come from the tree, not from the path.
 * A segment that is a plain folder (no page of its own) is shown but cannot be opened. */
export function Breadcrumbs({ path, tree, onNavigate }: BreadcrumbsProps) {
  const segments = path.split("/").filter(Boolean);
  return (
    <nav
      aria-label="Page breadcrumb"
      className="flex min-w-0 items-center gap-2 overflow-hidden text-sm text-muted-foreground"
    >
      {segments.map((segment, i) => {
        const ancestor = segments.slice(0, i + 1).join("/");
        const node = findNode(tree, ancestor);
        const isLast = i === segments.length - 1;
        const openable = isLast || node !== null || tree.length === 0;
        return (
          <span key={ancestor} className="flex min-w-0 items-center gap-2">
            {i > 0 && (
              <span aria-hidden="true" className="shrink-0">
                /
              </span>
            )}
            <button
              type="button"
              onClick={() => onNavigate(ancestor)}
              disabled={!openable}
              aria-current={isLast ? "page" : undefined}
              title={node?.title ?? segment}
              className={`flex min-w-0 items-center gap-1.5 transition-colors enabled:hover:text-foreground ${isLast ? "font-medium text-foreground" : ""}`}
            >
              <PageIcon
                icon={node?.icon ?? null}
                hasContent={node?.has_content ?? false}
                className="size-4 shrink-0"
              />
              <span className="truncate">{node?.title ?? segment}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}
