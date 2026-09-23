import type { TreeNode } from "./api";
import type { Scope } from "./ai";

export type CheckState = "checked" | "mixed" | "unchecked";

function walk(
  tree: TreeNode[],
  fn: (node: TreeNode, parents: TreeNode[]) => void,
  parents: TreeNode[] = [],
) {
  for (const node of tree) {
    fn(node, parents);
    walk(node.children, fn, [...parents, node]);
  }
}

export function allPaths(tree: TreeNode[]): string[] {
  const out: string[] = [];
  walk(tree, (n) => out.push(n.path));
  return out;
}

function under(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(r + "/"));
}

/** The set of checked pages a scope stands for. */
export function checkedFromScope(tree: TreeNode[], scope: Scope): Set<string> {
  const roots = scope.roots ?? [];
  const excluded = scope.excluded ?? [];
  const checked = new Set<string>();
  walk(tree, (n) => {
    const inRoots =
      scope.kind === "vault" ? !roots.length || under(n.path, roots) : under(n.path, roots);
    if (inRoots && !under(n.path, excluded)) checked.add(n.path);
  });
  return checked;
}

/** Tri-state for a node from its own check and its descendants'. */
export function stateOf(node: TreeNode, checked: Set<string>): CheckState {
  const paths = [node.path, ...allPaths(node.children)];
  const count = paths.filter((p) => checked.has(p)).length;
  if (count === 0) return "unchecked";
  if (count === paths.length) return "checked";
  return "mixed";
}

/**
 * Toggle a node: checking selects the subtree and every ancestor (a page in scope always
 * brings its parent chain, which is how subtree scopes are stored); unchecking drops the subtree.
 */
export function toggle(tree: TreeNode[], checked: Set<string>, path: string): Set<string> {
  const next = new Set(checked);
  let target: TreeNode | null = null;
  let chain: TreeNode[] = [];
  walk(tree, (n, parents) => {
    if (n.path === path) {
      target = n;
      chain = parents;
    }
  });
  if (!target) return next;
  const node: TreeNode = target;
  const subtree = [node.path, ...allPaths(node.children)];
  const on = stateOf(node, checked) !== "checked";
  for (const p of subtree) {
    if (on) next.add(p);
    else next.delete(p);
  }
  if (on) for (const parent of chain) next.add(parent.path);
  return next;
}

export function countSelected(
  tree: TreeNode[],
  checked: Set<string>,
): { selected: number; total: number } {
  const paths = allPaths(tree);
  return { selected: paths.filter((p) => checked.has(p)).length, total: paths.length };
}

/** Smallest vault scope (roots + excluded subtrees) that reproduces the checked set. */
export function normalizeSelection(tree: TreeNode[], checked: Set<string>): Scope {
  const roots: string[] = [];
  const excluded: string[] = [];
  const visit = (nodes: TreeNode[], insideRoot: boolean) => {
    for (const node of nodes) {
      const state = stateOf(node, checked);
      if (state === "checked") {
        if (!insideRoot) roots.push(node.path);
        continue;
      }
      if (state === "unchecked") {
        if (insideRoot) excluded.push(node.path);
        continue;
      }
      // Mixed: the node itself is checked (ancestors always are); descend.
      if (!insideRoot) roots.push(node.path);
      visit(node.children, true);
    }
  };
  visit(tree, false);
  const everyTop = tree.every((n) => stateOf(n, checked) !== "unchecked");
  if (everyTop && tree.length) {
    // All top-level pages take part: express as "whole vault minus exclusions".
    const onlyExcluded: string[] = [];
    const collect = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        const state = stateOf(node, checked);
        if (state === "unchecked") onlyExcluded.push(node.path);
        else if (state === "mixed") collect(node.children);
      }
    };
    collect(tree);
    return { kind: "vault", roots: [], excluded: onlyExcluded };
  }
  return { kind: "vault", roots, excluded };
}

export function scopeLabel(scope: Scope, count: { selected: number; total: number }): string {
  if (scope.kind === "vault" && !scope.roots?.length && !scope.excluded?.length) return "All pages";
  return `${count.selected} of ${count.total} pages`;
}
