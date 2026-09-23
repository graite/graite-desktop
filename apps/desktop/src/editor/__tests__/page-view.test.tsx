import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { MediaContext } from "../media/context";
import { PageViewBody } from "../views/PageViewBody";
import { mergeFields, visibleFields } from "../views/collection";
import { DRAG_TYPE } from "../views/BoardView";
import type { GraiteEditor } from "../schema";
import { schema } from "../schema";
import { BlockNoteEditor } from "@blocknote/core";
import { EditorSurface } from "../EditorSurface";

const status = (value: string | null, options = ["To do", "Done"]): PageProperty => ({
  id: `s-${value}`,
  name: "Status",
  type: "status",
  options,
  colors: {},
  value,
});
const page = (id: string, title: string, props: PageProperty[], hash = "h1"): PageDoc => ({
  id,
  path: `Board/${title}`,
  title,
  icon: null,
  frontmatter: { properties: props },
  body: "",
  hash,
});

const pages = [
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
  page("c", "Gamma", []),
];

function mount(props: { view: "table" | "kanban" | "list"; group?: string; show?: string }) {
  const editor = { updateBlock: vi.fn() } as unknown as GraiteEditor;
  const navigate = vi.fn();
  render(
    <MediaContext.Provider
      value={{ pageId: "root", pagePath: "Board", navigate, onTreeChanged: () => {} }}
    >
      <PageViewBody
        id="blk"
        props={{ view: props.view, group: props.group ?? "", show: props.show ?? "" }}
        editor={editor}
      />
    </MediaContext.Provider>,
  );
  return { editor, navigate };
}

function dataTransfer(id: string) {
  return {
    types: [DRAG_TYPE],
    getData: () => id,
    setData: vi.fn(),
    effectAllowed: "",
    dropEffect: "",
  };
}

beforeEach(() => {
  api.children.mockResolvedValue(pages);
  api.properties.mockImplementation(async (id: string, properties: PageProperty[]) => ({
    ...pages.find((p) => p.id === id)!,
    frontmatter: { properties },
    hash: "h2",
  }));
  api.move.mockResolvedValue(pages[0]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("keeps collection-table mouse events out of native table handles without blocking navigation", async () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [
      { type: "pageView", props: { view: "table" } },
      { type: "table", content: { type: "tableContent", rows: [{ cells: ["Native cell"] }] } },
    ],
  }) as GraiteEditor;
  const navigate = vi.fn();
  const errors: unknown[] = [];
  // jsdom has no layout hit-testing; unrelated editor hover plugins use these methods.
  const hitTests = ["elementFromPoint", "elementsFromPoint"] as const;
  const descriptors = hitTests.map((name) => Object.getOwnPropertyDescriptor(document, name));
  hitTests.forEach((name) =>
    Object.defineProperty(document, name, {
      configurable: true,
      value: () => (name === "elementsFromPoint" ? [] : null),
    }),
  );
  const onError = (event: ErrorEvent) => {
    errors.push(event.error);
    event.preventDefault();
  };
  window.addEventListener("error", onError);
  try {
    render(
      <MediaContext.Provider
        value={{ pageId: "root", pagePath: "Board", navigate, onTreeChanged: () => {} }}
      >
        <EditorSurface
          editor={editor}
          onChange={() => {}}
          slashDeps={{
            createChildPage: async () => {
              throw Error();
            },
            pickPage: async () => null,
            onTreeChanged: () => {},
          }}
        />
      </MediaContext.Provider>,
    );
    const title = await screen.findByText("Alpha");
    const cell = title.closest("td")!;
    fireEvent.mouseMove(cell);
    fireEvent.mouseDown(cell);
    fireEvent.mouseUp(cell);
    fireEvent.click(title);
    expect(navigate).toHaveBeenCalledWith("Board/Alpha");
    // Real Markdown tables still reach the normal BlockNote table handler.
    fireEvent.mouseMove(screen.getByText("Native cell").closest("td")!);
    expect(errors).toEqual([]);
  } finally {
    window.removeEventListener("error", onError);
    hitTests.forEach((name, index) => {
      if (descriptors[index]) Object.defineProperty(document, name, descriptors[index]!);
      else Reflect.deleteProperty(document, name);
    });
  }
});

describe("collection helpers", () => {
  it("merges property definitions across sibling pages", () => {
    const fields = mergeFields([
      page("x", "X", [status("To do", ["To do"])]),
      page("y", "Y", [{ ...status("Done", ["Done", "Later"]), colors: { Done: "green" } }]),
    ]);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: "Status",
      options: ["To do", "Done", "Later"],
      colors: { Done: "green" },
      value: null,
    });
    expect(visibleFields(fields, "", "table")).toEqual(fields);
    expect(visibleFields(fields, "", "kanban")).toEqual([]);
    expect(visibleFields(fields, JSON.stringify({ list: ["status"] }), "list")).toEqual(fields);
    expect(visibleFields(fields, JSON.stringify({ kanban: ["Status"] }), "table")).toEqual(fields);
  });
});

describe("board view", () => {
  it("groups pages into option columns plus a column for pages without a value", async () => {
    mount({ view: "kanban", group: "Status", show: JSON.stringify({ kanban: ["Priority"] }) });
    await screen.findByText("Alpha");
    const headers = document.querySelectorAll(".view-column-header");
    expect([...headers].map((h) => h.textContent)).toEqual(["To do1", "Done1", "No Status1"]);
    expect(screen.getByText("High").getAttribute("data-color")).toBe("red");
    expect(screen.queryByText("Status", { selector: ".view-chips *" })).toBeNull();
  });

  it("dropping a card on another card changes its status and reorders it", async () => {
    mount({ view: "kanban", group: "Status" });
    const alpha = (await screen.findByText("Alpha")).closest(".view-card")!;
    const beta = screen.getByText("Beta").closest(".view-card")! as HTMLElement;
    beta.getBoundingClientRect = () => ({
      top: 100,
      height: 40,
      bottom: 140,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    // jsdom has no DragEvent, so clientY must be attached by hand.
    const at = (type: "dragOver" | "drop", y: number) => {
      const ev = createEvent[type](beta, { dataTransfer: dataTransfer("a") });
      Object.defineProperty(ev, "clientY", { value: y });
      return ev;
    };
    fireEvent.dragStart(alpha, { dataTransfer: dataTransfer("a") });
    fireEvent(beta, at("dragOver", 105));
    expect(beta.getAttribute("data-drop")).toBe("before");
    fireEvent(beta, at("drop", 105));
    await waitFor(() => expect(api.move).toHaveBeenCalledWith("a", "b", "before"));
    expect(api.properties).toHaveBeenCalledTimes(1);
    const [id, props, hash] = api.properties.mock.calls[0] as [string, PageProperty[], string];
    expect(id).toBe("a");
    expect(hash).toBe("h1");
    expect(props.find((p) => p.name === "Status")?.value).toBe("Done");
  });

  it("adds the property from the merged definition when a page lacks it", async () => {
    mount({ view: "kanban", group: "Status" });
    const gamma = (await screen.findByText("Gamma")).closest(".view-card")!;
    const column = screen.getByText("To do").closest(".view-column")!;
    fireEvent.dragStart(gamma, { dataTransfer: dataTransfer("c") });
    fireEvent.drop(column, { dataTransfer: dataTransfer("c") });
    await waitFor(() => expect(api.properties).toHaveBeenCalled());
    const [, props] = api.properties.mock.calls[0] as [string, PageProperty[]];
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({
      name: "Status",
      type: "status",
      options: ["To do", "Done"],
      value: "To do",
    });
    expect(api.move).toHaveBeenCalledWith("c", "a", "after");
  });

  it("retries once with a fresh page after a conflict", async () => {
    const { ConflictError } = await import("@/lib/api");
    api.properties
      .mockRejectedValueOnce(new ConflictError("h9", ""))
      .mockResolvedValueOnce({ ...pages[0], hash: "h10" });
    api.get.mockResolvedValue({ ...pages[0], hash: "h9" });
    mount({ view: "kanban", group: "Status" });
    const alpha = (await screen.findByText("Alpha")).closest(".view-card")!;
    fireEvent.drop(screen.getByText("Done").closest(".view-column")!, {
      dataTransfer: dataTransfer("a"),
    });
    await waitFor(() => expect(api.properties).toHaveBeenCalledTimes(2));
    expect(api.properties.mock.calls[1][2]).toBe("h9");
    expect(alpha).toBeTruthy();
  });

  it("creates a page in a column with that status", async () => {
    api.create.mockResolvedValue(page("d", "Delta", [], "h3"));
    mount({ view: "kanban", group: "Status" });
    await screen.findByText("Alpha");
    fireEvent.click(screen.getAllByText("New")[1]);
    const input = screen.getByLabelText("New page title");
    fireEvent.change(input, { target: { value: "Delta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ parentPath: "Board", title: "Delta" }),
    );
    await waitFor(() => expect(api.properties).toHaveBeenCalled());
    expect((api.properties.mock.calls[0][1] as PageProperty[])[0]).toMatchObject({
      name: "Status",
      value: "To do",
    });
  });
});

describe("toolbar", () => {
  it("persists the view type and the shown properties on the block", async () => {
    const { editor } = mount({ view: "list" });
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(editor.updateBlock).toHaveBeenCalledWith("blk", {
      type: "pageView",
      props: { view: "kanban" },
    });
    fireEvent.click(screen.getByLabelText("Shown properties"));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Show Priority" }));
    expect(editor.updateBlock).toHaveBeenLastCalledWith("blk", {
      type: "pageView",
      props: { show: JSON.stringify({ list: ["Priority"] }) },
    });
    expect(
      screen.getByRole("checkbox", { name: "Show Priority" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("table shows only the chosen columns and offers to add a missing property", async () => {
    mount({ view: "table", show: JSON.stringify({ table: ["Priority"], kanban: [] }) });
    await screen.findByText("Alpha");
    expect([...document.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Name",
      "Priority",
    ]);
    fireEvent.click(screen.getAllByLabelText("Add Priority")[0]);
    await waitFor(() => expect(api.properties).toHaveBeenCalled());
    expect((api.properties.mock.calls[0][1] as PageProperty[]).map((p) => p.name)).toEqual([
      "Status",
      "Priority",
    ]);
  });
});

it("renders usable backlog columns before the first card exists", async () => {
  api.children.mockResolvedValue([]);
  mount({ view: "kanban", group: "Status" });
  await screen.findByText("Backlog");
  expect([...document.querySelectorAll(".view-column-header")].map((h) => h.textContent)).toEqual([
    "Backlog0",
    "To do0",
    "In progress0",
    "Done0",
    "No Status0",
  ]);
  expect(screen.queryByText("No pages yet.")).toBeNull();
});

it("keeps configured fields on an empty board and applies them to its first card", async () => {
  api.children.mockResolvedValue([]);
  const created = page("new", "Call dentist", []);
  api.create.mockResolvedValue(created);
  api.properties.mockImplementation(async (_id: string, properties: PageProperty[]) => ({
    ...created,
    frontmatter: { properties },
  }));
  const editor = { updateBlock: vi.fn() } as unknown as GraiteEditor;
  const fields = [
    status(null, ["Backlog", "Done"]),
    {
      id: "priority",
      name: "Priority",
      type: "single_select",
      options: ["High", "Low"],
      value: null,
    },
  ];
  render(
    <MediaContext.Provider value={{ pageId: "root", pagePath: "Board", onTreeChanged: () => {} }}>
      <PageViewBody
        id="blk"
        props={{ view: "kanban", group: "Status", show: "", settings: JSON.stringify({ fields }) }}
        editor={editor}
      />
    </MediaContext.Provider>,
  );
  const column = (await screen.findByText("Backlog")).closest(".view-column")!;
  fireEvent.click(column.querySelector(".view-column-new")!);
  const input = screen.getByPlaceholderText("Page title");
  fireEvent.change(input, { target: { value: "Call dentist" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(api.properties).toHaveBeenCalled());
  const initial = api.properties.mock.calls[0][1] as PageProperty[];
  expect(initial.find((f) => f.name === "Status")?.value).toBe("Backlog");
  expect(initial.find((f) => f.name === "Priority")?.options).toEqual(["High", "Low"]);
});
