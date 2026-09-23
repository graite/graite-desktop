import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import type { PageDoc } from "@/lib/api";
import type { PageProperty } from "@/lib/workspace";

const api = vi.hoisted(() => ({
  children: vi.fn(),
  properties: vi.fn(),
  move: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace")>()),
  workspace: { children: api.children, properties: api.properties, move: api.move },
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    onDaemonEvent: () => () => {},
    isOwnRequest: () => false,
    pages: { ...real.pages, create: api.create, get: api.get },
  };
});

import { EditorSurface } from "../EditorSurface";
import { MediaContext } from "../media/context";
import { schema, type GraiteEditor } from "../schema";

// jsdom has no layout; floating UI and ProseMirror need these to exist.
const rect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as DOMRect;
Element.prototype.getBoundingClientRect = () => rect;
Range.prototype.getBoundingClientRect = () => rect;
Range.prototype.getClientRects = () =>
  ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;

const status = (value: string | null): PageProperty => ({
  id: `s-${value}`,
  name: "Status",
  type: "status",
  options: ["To do", "Done"],
  colors: {},
  value,
});
const page = (id: string, title: string, props: PageProperty[]): PageDoc => ({
  id,
  path: `Board/${title}`,
  title,
  icon: null,
  frontmatter: { properties: props },
  body: id === "a" ? "Some text" : "",
  hash: "h1",
});
const rows = [
  page("a", "Alpha", [
    status("To do"),
    {
      id: "p1",
      name: "Priority",
      type: "single_select",
      options: ["High"],
      colors: { High: "red" },
      value: "High",
    },
  ]),
  page("b", "Beta", [status("Done")]),
];

beforeEach(() => {
  api.children.mockResolvedValue(rows);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("toggles a property for the active view only and keeps the menu open", async () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [{ type: "pageView", props: { view: "kanban", group: "Status", show: "" } }],
  }) as GraiteEditor;
  const slashDeps = {
    createChildPage: vi.fn(),
    pickPage: vi.fn(),
    onTreeChanged: vi.fn(),
  } as unknown as Parameters<typeof EditorSurface>[0]["slashDeps"];
  render(
    <MediaContext.Provider value={{ pageId: "root", pagePath: "Board", onTreeChanged: () => {} }}>
      <EditorSurface editor={editor} slashDeps={slashDeps} onChange={() => {}} />
    </MediaContext.Provider>,
  );
  await screen.findByText("Alpha");
  expect(screen.queryByText("High")).toBeNull();

  fireEvent.click(screen.getByLabelText("Shown properties"));
  const box = await screen.findByRole("checkbox", { name: "Show Priority" });
  fireEvent.click(box);
  await waitFor(() =>
    expect(editor.document[0]!.props).toMatchObject({
      show: JSON.stringify({ kanban: ["Priority"] }),
    }),
  );
  expect(screen.getByRole("checkbox", { name: "Show Priority" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  await waitFor(() => expect(screen.getByText("High").getAttribute("data-color")).toBe("red"));

  fireEvent.click(box);
  await waitFor(() =>
    expect(editor.document[0]!.props).toMatchObject({ show: JSON.stringify({ kanban: [] }) }),
  );
  expect(screen.getByRole("checkbox", { name: "Show Priority" }).getAttribute("aria-checked")).toBe(
    "false",
  );

  fireEvent.click(screen.getByRole("tab", { name: "Table" }));
  await waitFor(() => expect(editor.document[0]!.props).toMatchObject({ view: "table" }));
  await waitFor(() =>
    expect([...document.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Name",
      "Status",
      "Priority",
    ]),
  );

  // Empty pages get the blank page icon, pages with text the lined one.
  const icons = [...document.querySelectorAll(".view-page-icon svg")].map(
    (svg) => svg.getAttribute("class") ?? "",
  );
  expect(icons.some((c) => c.includes("lucide-file-text"))).toBe(true);
  expect(icons.some((c) => c.includes("lucide-file") && !c.includes("lucide-file-text"))).toBe(
    true,
  );
});

it("sorts table rows, searches locally and persists board visibility", async () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [{ type: "pageView", props: { view: "table", group: "Status" } }],
  }) as GraiteEditor;
  render(
    <MediaContext.Provider value={{ pageId: "root", pagePath: "Board", onTreeChanged: () => {} }}>
      <EditorSurface
        editor={editor}
        slashDeps={{ createChildPage: vi.fn(), pickPage: vi.fn(), onTreeChanged: vi.fn() }}
        onChange={() => {}}
      />
    </MediaContext.Provider>,
  );
  await screen.findByText("Alpha");
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  await waitFor(() =>
    expect([...document.querySelectorAll(".view-page")].map((n) => n.textContent)).toEqual([
      "Beta",
      "Alpha",
    ]),
  );
  expect(JSON.parse((editor.document[0]!.props as { settings: string }).settings).sort).toEqual({
    field: "$title",
    direction: "desc",
  });
  fireEvent.click(screen.getByRole("button", { name: "Search view" }));
  fireEvent.change(screen.getByLabelText("Search pages in view"), { target: { value: "alpha" } });
  expect([...document.querySelectorAll(".view-page")].map((n) => n.textContent)).toEqual(["Alpha"]);
  fireEvent.click(screen.getByLabelText("Clear search"));
  fireEvent.click(screen.getByRole("tab", { name: "Board" }));
  fireEvent.click(await screen.findByLabelText("Hide Done column"));
  await waitFor(() => expect(screen.queryByLabelText("Hide Done column")).toBeNull());
  expect(
    JSON.parse((editor.document[0]!.props as { settings: string }).settings).boards.Status.hidden,
  ).toEqual(["Done"]);
});

it("keeps New page available when every board column is hidden", async () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [
      {
        type: "pageView",
        props: {
          view: "kanban",
          group: "Status",
          settings: JSON.stringify({
            boards: { Status: { order: [], hidden: ["To do", "Done", ""] } },
          }),
        },
      },
    ],
  }) as GraiteEditor;
  render(
    <MediaContext.Provider value={{ pageId: "root", pagePath: "Board", onTreeChanged: () => {} }}>
      <EditorSurface
        editor={editor}
        slashDeps={{ createChildPage: vi.fn(), pickPage: vi.fn(), onTreeChanged: vi.fn() }}
        onChange={() => {}}
      />
    </MediaContext.Provider>,
  );
  await screen.findByText("All columns are hidden. Show them in the Columns menu.");
  fireEvent.click(screen.getByRole("button", { name: /^New$/ }));
  expect(await screen.findByLabelText("New page title")).toBeTruthy();
});

it("creates an editable filter pill and persists edits from custom menus", async () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [{ type: "pageView", props: { view: "table" } }],
  }) as GraiteEditor;
  render(
    <MediaContext.Provider value={{ pageId: "root", pagePath: "Board", onTreeChanged: () => {} }}>
      <EditorSurface
        editor={editor}
        slashDeps={{ createChildPage: vi.fn(), pickPage: vi.fn(), onTreeChanged: vi.fn() }}
        onChange={() => {}}
      />
    </MediaContext.Provider>,
  );
  await screen.findByText("Alpha");
  fireEvent.click(screen.getByLabelText("Add filter"));
  const menu = screen.getByText("Filter by property").closest('[data-slot="popover-content"]')!;
  fireEvent.click(within(menu as HTMLElement).getByRole("button", { name: "Name" }));
  const value = await screen.findByLabelText("Filter value");
  fireEvent.change(value, { target: { value: "Alpha" } });
  await waitFor(() =>
    expect(
      JSON.parse((editor.document[0]!.props as { settings: string }).settings).filters,
    ).toEqual([{ field: "$title", op: "contains", value: "Alpha" }]),
  );
  expect(screen.getByLabelText("Edit filter: Name: Contains Alpha")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Filter condition"));
  expect(document.querySelectorAll("select").length).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Is not" }));
  await waitFor(() =>
    expect([...document.querySelectorAll(".view-page")].map((n) => n.textContent)).toEqual([
      "Beta",
    ]),
  );
  fireEvent.click(screen.getByLabelText("Filter actions"));
  fireEvent.click(screen.getByRole("button", { name: "Remove filter" }));
  await waitFor(() => expect(screen.queryByLabelText("Active filters")).toBeNull());
});

it("closes a view menu when clicking elsewhere in the view", async () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [{ type: "pageView", props: { view: "table", show: "" } }],
  }) as GraiteEditor;
  const slashDeps = {
    createChildPage: vi.fn(),
    pickPage: vi.fn(),
    onTreeChanged: vi.fn(),
  } as unknown as Parameters<typeof EditorSurface>[0]["slashDeps"];
  render(
    <MediaContext.Provider value={{ pageId: "root", pagePath: "Board", onTreeChanged: () => {} }}>
      <EditorSurface editor={editor} slashDeps={slashDeps} onChange={() => {}} />
    </MediaContext.Provider>,
  );
  const cell = (await screen.findByText("Alpha")).closest("td")!;

  fireEvent.click(screen.getByLabelText("Shown properties"));
  await screen.findByRole("checkbox", { name: "Show Priority" });
  // Let Radix attach its outside-pointer listener (it waits one tick).
  await new Promise((resolve) => setTimeout(resolve, 0));

  fireEvent.pointerDown(cell, { button: 0 });
  fireEvent.mouseDown(cell, { button: 0 });
  fireEvent.pointerUp(cell, { button: 0 });
  fireEvent.mouseUp(cell, { button: 0 });
  fireEvent.click(cell, { button: 0 });
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Show Priority" })).toBeNull());
});
