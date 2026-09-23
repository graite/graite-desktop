import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScopeDialog } from "../ScopeDialog";
import { checkedFromScope, countSelected, normalizeSelection, stateOf, toggle } from "@/lib/scope";
import type { TreeNode } from "@/lib/api";

afterEach(cleanup);

const node = (path: string, title: string, children: TreeNode[] = []): TreeNode => ({
  path,
  id: path,
  title,
  icon: null,
  has_content: true,
  children,
});
const tree: TreeNode[] = [
  node("Projects", "Projects", [
    node("Projects/Atlas", "Atlas"),
    node("Projects/Pricing", "Pricing"),
  ]),
  node("Journal", "Journal"),
];
const ALL = { kind: "vault" as const, roots: [], excluded: [] };

it("defaults to every page and reports the count", () => {
  const checked = checkedFromScope(tree, ALL);
  expect(countSelected(tree, checked)).toEqual({ selected: 4, total: 4 });
  expect(normalizeSelection(tree, checked)).toEqual({ kind: "vault", roots: [], excluded: [] });
});

it("unchecking a parent clears its subtree and leaves the parent mixed when a child returns", () => {
  let checked = checkedFromScope(tree, ALL);
  checked = toggle(tree, checked, "Projects");
  expect(stateOf(tree[0], checked)).toBe("unchecked");
  expect(countSelected(tree, checked).selected).toBe(1);
  expect(normalizeSelection(tree, checked)).toEqual({
    kind: "vault",
    roots: ["Journal"],
    excluded: [],
  });
  checked = toggle(tree, checked, "Projects/Atlas");
  expect(stateOf(tree[0], checked)).toBe("mixed");
  expect(normalizeSelection(tree, checked)).toEqual({
    kind: "vault",
    roots: [],
    excluded: ["Projects/Pricing"],
  });
});

it("renders a tri-state tree and applies the selection", () => {
  const onApply = vi.fn();
  render(<ScopeDialog open tree={tree} scope={ALL} onApply={onApply} onCancel={vi.fn()} />);
  expect(screen.getByText("4 of 4 pages")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Expand Projects" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Atlas" }));
  expect(screen.getByRole("checkbox", { name: "Projects" }).getAttribute("aria-checked")).toBe(
    "mixed",
  );
  expect(screen.getByText("3 of 4 pages")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use these pages" }));
  expect(onApply).toHaveBeenCalledWith({ kind: "vault", roots: [], excluded: ["Projects/Atlas"] });
});

it("round-trips any selection reachable by clicking", () => {
  const deep: TreeNode[] = [
    node("A", "A", [node("A/1", "One", [node("A/1/x", "X")]), node("A/2", "Two")]),
    node("B", "B", [node("B/1", "One")]),
    node("C", "C"),
  ];
  const paths = ["A", "A/1", "A/1/x", "A/2", "B", "B/1", "C"];
  let checked = checkedFromScope(deep, { kind: "vault", roots: [], excluded: [] });
  // Every state reachable by clicking must survive a save-and-reload of the scope.
  for (let step = 0; step < 60; step++) {
    checked = toggle(deep, checked, paths[step % paths.length]);
    const scope = normalizeSelection(deep, checked);
    expect(checkedFromScope(deep, scope)).toEqual(checked);
  }
});

it("selects all descendants when their collapsed parent is selected", () => {
  const deep = [
    node("Projects", "Projects", [
      node("Projects/Design", "Design", [node("Projects/Design/Ideas", "Ideas")]),
    ]),
    node("Journal", "Journal"),
  ];
  const onApply = vi.fn();
  render(<ScopeDialog open tree={deep} scope={ALL} onApply={onApply} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Projects" }));
  expect(screen.getByText("3 of 4 pages")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Expand Projects" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand Design" }));
  expect(screen.getByRole("checkbox", { name: "Ideas" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Use these pages" }));
  expect(onApply).toHaveBeenCalledWith({ kind: "vault", roots: ["Projects"], excluded: [] });
});

it("expands compact search and keeps hidden descendants selected when choosing a parent", () => {
  render(<ScopeDialog open tree={tree} scope={ALL} onApply={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.queryByRole("textbox", { name: "Search pages" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  fireEvent.click(screen.getByRole("button", { name: "Search pages" }));
  const search = screen.getByRole("textbox", { name: "Search pages" });
  fireEvent.change(search, { target: { value: "Atlas" } });
  expect(screen.queryByRole("checkbox", { name: "Pricing" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Projects" }));
  expect(screen.getByText("3 of 4 pages")).toBeTruthy();
  fireEvent.change(search, { target: { value: "no-such-page" } });
  expect(screen.getByText(/No pages match/)).toBeTruthy();
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Search pages" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand Projects" }));
  expect(screen.getByRole("checkbox", { name: "Pricing" }).getAttribute("aria-checked")).toBe(
    "true",
  );
});
