import type { TreeNode } from "@/lib/api";

export function findNode(tree: TreeNode[], path: string): TreeNode | null {
  for (const node of tree) {
    if (node.path === path) return node;
    const found = findNode(node.children, path);
    if (found) return found;
  }
  return null;
}

export function parentPath(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

export function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Resolve a `[[target]]` written inside `pagePath` to a child of that page (title or folder name). */
export function resolveChild(tree: TreeNode[], pagePath: string, target: string): TreeNode | null {
  const page = findNode(tree, pagePath);
  if (!page) return null;
  return (
    page.children.find((c) => c.title === target) ??
    page.children.find((c) => lastSegment(c.path) === target) ??
    null
  );
}

export function mapTree(tree: TreeNode[], fn: (n: TreeNode) => TreeNode): TreeNode[] {
  return tree.map((n) => fn({ ...n, children: mapTree(n.children, fn) }));
}

export interface FlatPage {
  path: string;
  title: string;
  icon: string | null;
  hasContent: boolean;
  /** Ancestor titles joined with " / " for display. */
  breadcrumb: string;
}

export function allPages(
  tree: TreeNode[],
  prefix: string[] = [],
  out: FlatPage[] = [],
): FlatPage[] {
  for (const n of tree) {
    out.push({
      path: n.path,
      title: n.title,
      icon: n.icon,
      hasContent: n.has_content,
      breadcrumb: prefix.join(" / "),
    });
    allPages(n.children, [...prefix, n.title], out);
  }
  return out;
}

/** Wikilink text for a page link written inside `fromPath` (docs/vault-format.md §5). */
export function linkTarget(fromPath: string, node: { path: string; title: string }): string {
  return parentPath(node.path) === fromPath ? node.title : node.path;
}

/** Resolve a wikilink target written inside `fromPath`: child by title/folder, then full path, then vault-wide title. */
export function resolveTarget(tree: TreeNode[], fromPath: string, target: string): TreeNode | null {
  return (
    resolveChild(tree, fromPath, target) ?? findNode(tree, target) ?? findByTitle(tree, target)
  );
}

export function findByTitle(tree: TreeNode[], title: string): TreeNode | null {
  for (const n of tree) {
    if (n.title === title) return n;
    const f = findByTitle(n.children, title);
    if (f) return f;
  }
  return null;
}
