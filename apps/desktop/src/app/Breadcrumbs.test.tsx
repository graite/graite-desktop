import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Breadcrumbs } from "./Breadcrumbs";
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

it("opens an ancestor page", () => {
  const tree = [node("Projects", "Projects", [node("Projects/Garden", "Garden")])];
  const onNavigate = vi.fn();
  render(<Breadcrumbs path="Projects/Garden" tree={tree} onNavigate={onNavigate} />);
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
  expect(onNavigate).toHaveBeenCalledWith("Projects");
});

it("does not try to open a plain folder that has no page", () => {
  // Notes/ holds pages but no page.md of its own; the tree attaches Idea at the top level.
  const tree = [node("Notes/Idea", "Idea")];
  const onNavigate = vi.fn();
  render(<Breadcrumbs path="Notes/Idea" tree={tree} onNavigate={onNavigate} />);
  const folder = screen.getByRole("button", { name: "Notes" });
  expect((folder as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(folder);
  expect(onNavigate).not.toHaveBeenCalled();
});
