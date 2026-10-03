import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import type { GridProps } from "./TableGrid";
import { TableViewBody } from "./TableViewBody";

const state = vi.hoisted(() => ({ name: "name" }));
const api = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ path: "Atlas/_data/t.csv" })),
  rows: vi.fn(async () => ({
    path: "Atlas/_data/t.csv",
    page_path: "Atlas",
    name: "t",
    hash: "h",
    row_count: 1,
    primary_key: "id",
    display: null,
    columns: [
      { name: "id", type: "text" },
      { name: state.name, type: "text" },
    ],
    warnings: [],
    visible: ["id", state.name],
    total: 1,
    offset: 0,
    rows: [{ id: "a", cells: ["a", "x"] }],
  })),
  list: vi.fn(async () => []),
  columns: vi.fn(async (_path: string, ops: { op: string; to?: string }[]) => {
    if (ops[0]?.to) state.name = ops[0].to;
    return { path: "Atlas/_data/t.csv", hash: "h2", ids: [] };
  }),
}));
vi.mock("@/lib/tables", () => ({
  describeWarning: (w: string) => w,
  isRelationLinks: () => false,
  sourceFor: (_page: string, t: { path: string }) => t.path,
  tables: api,
}));
vi.mock("./TableGrid", () => ({
  emptySelection: () => ({ columns: { toArray: () => [] }, rows: { toArray: () => [] } }),
  TableGrid: (p: GridProps) => (
    <div data-testid="grid">
      {p.columns.map((c) => (
        <button
          key={c.name}
          onClick={() => p.onHeaderMenu(c, { x: 0, y: 0, width: 100, height: 30 })}
        >
          header:{c.name}
        </button>
      ))}
    </div>
  ),
}));

afterEach(cleanup);

it("renames a field when only its capitals change", async () => {
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "Atlas", onTreeChanged: () => {} }}>
      <TableViewBody
        id="b"
        props={{
          source: "_data/t.csv",
          view: "",
          filter: "",
          sort: "",
          columns: "",
          height: 0,
          embed: false,
          tabs: "",
        }}
        editor={{ updateBlock: vi.fn() } as unknown as GraiteEditor}
      />
    </MediaContext.Provider>,
  );
  fireEvent.click(await screen.findByText("header:name"));
  const input = await screen.findByLabelText("Field name");
  fireEvent.change(input, { target: { value: "Name" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(api.columns).toHaveBeenCalledWith("Atlas/_data/t.csv", [
      { op: "rename", name: "name", to: "Name" },
    ]),
  );
  expect(await screen.findByText("header:Name")).toBeTruthy();
});

it("keeps a rename when the menu closes without Enter", async () => {
  state.name = "notes";
  api.columns.mockClear();
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "Atlas", onTreeChanged: () => {} }}>
      <TableViewBody
        id="b"
        props={{
          source: "_data/t.csv",
          view: "",
          filter: "",
          sort: "",
          columns: "",
          height: 0,
          embed: false,
          tabs: "",
        }}
        editor={{ updateBlock: vi.fn() } as unknown as GraiteEditor}
      />
    </MediaContext.Provider>,
  );
  fireEvent.click(await screen.findByText("header:notes"));
  const input = await screen.findByLabelText("Field name");
  fireEvent.change(input, { target: { value: "Notes" } });
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() =>
    expect(api.columns).toHaveBeenCalledWith("Atlas/_data/t.csv", [
      { op: "rename", name: "notes", to: "Notes" },
    ]),
  );
});
