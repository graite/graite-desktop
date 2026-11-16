import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TreeNode } from "@/lib/api";
import { TabBar } from "../TabBar";

afterEach(cleanup);

const page = (path: string, title: string) =>
  ({ path, title, icon: null, has_content: true, children: [] }) as unknown as TreeNode;
const tree = [page("Notes", "Notes"), page("Plans", "Plans")];

it("offers a new page or an existing one from the + menu", async () => {
  const onNew = vi.fn();
  const onOpen = vi.fn();
  render(
    <TabBar
      tabs={["Notes"]}
      active="Notes"
      tree={tree}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onNew={onNew}
      onOpen={onOpen}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "New tab" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Add new page/ }));
  expect(onNew).toHaveBeenCalled();

  fireEvent.keyDown(screen.getByRole("button", { name: "New tab" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Open a page/ }));
  fireEvent.change(await screen.findByPlaceholderText("Search pages…"), {
    target: { value: "pla" },
  });
  expect(screen.queryByRole("button", { name: /Notes/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Plans/ }));
  expect(onOpen).toHaveBeenCalledWith("Plans");
});
