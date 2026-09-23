import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PageTreeItem, type PageTreeItemProps } from "../PageTreeItem";
afterEach(cleanup);
it.each(["before", "after", "inside"] as const)(
  "moves a page %s through distinct drop targets",
  (position) => {
    const move = vi.fn(async () => {});
    const props: PageTreeItemProps = {
      node: {
        id: "target",
        path: "Target",
        title: "Target",
        icon: null,
        has_content: false,
        children: [],
      },
      depth: 0,
      selectedPath: null,
      expanded: new Set(),
      renamingPath: null,
      onMove: move,
      onSelect: vi.fn(),
      onToggle: vi.fn(),
      onCreateSubpage: vi.fn(),
      onStartRename: vi.fn(),
      onCommitRename: vi.fn(),
      onCancelRename: vi.fn(),
      onDelete: vi.fn(),
      onMoveMenu: vi.fn(),
      onAiSettings: vi.fn(),
      onIconChange: vi.fn(),
    };
    const { container } = render(<PageTreeItem {...props} />);
    const target = container.querySelector(
      position === "inside" ? "[data-media-drop-page]" : `[data-drop-gap=${position}]`,
    )!;
    const dataTransfer = {
      types: ["application/graite-sidebar-page"],
      getData: () => JSON.stringify({ id: "source", path: "Source" }),
      dropEffect: "none",
    };
    fireEvent.dragOver(target, { dataTransfer });
    expect(
      target.getAttribute(position === "inside" ? "data-page-drop-position" : "data-active"),
    ).toBe(position === "inside" ? "inside" : "true");
    fireEvent.drop(target, { dataTransfer });
    expect(move).toHaveBeenCalledWith("source", "Source", "target", position);
    expect(
      target.hasAttribute(position === "inside" ? "data-page-drop-position" : "data-active"),
    ).toBe(false);
  },
);

it("keeps a view's entries out of the tree", () => {
  const entry = {
    id: "card",
    path: "Board/Card",
    title: "Card",
    icon: null,
    has_content: false,
    children: [],
  };
  const node = {
    id: "board",
    path: "Board",
    title: "Board",
    icon: null,
    has_content: true,
    has_view: true,
    children: [entry],
  };
  const props: PageTreeItemProps = {
    node,
    depth: 0,
    selectedPath: "Board/Card",
    expanded: new Set(["Board"]),
    renamingPath: null,
    onMove: vi.fn(),
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onCreateSubpage: vi.fn(),
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onDelete: vi.fn(),
    onMoveMenu: vi.fn(),
    onAiSettings: vi.fn(),
    onIconChange: vi.fn(),
  };
  const { queryByText } = render(<PageTreeItem {...props} />);
  expect(queryByText("Board")).not.toBeNull();
  expect(queryByText("Card")).toBeNull();
});
