import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import { TableViewBody } from "./TableViewBody";

vi.mock("@/lib/tables", () => ({
  describeWarning: (w: string) => w,
  isRelationLinks: () => false,
  sourceFor: (_page: string, t: { path: string }) => t.path,
  tables: {
    list: vi.fn(async () => []),
    resolve: vi.fn(async () => ({ path: "Atlas/_data/expenses.csv" })),
    rows: vi.fn(async () => ({
      path: "Atlas/_data/expenses.csv",
      page_path: "Atlas",
      name: "expenses",
      hash: "h",
      row_count: 1,
      primary_key: "id",
      display: null,
      columns: [
        { name: "id", type: "text" },
        { name: "amount", type: "number" },
      ],
      warnings: [],
      visible: ["id", "amount"],
      total: 1,
      offset: 0,
      rows: [{ id: "a", cells: ["a", 12] }],
    })),
  },
}));
// The canvas grid needs a real browser; a plain element stands in for it.
vi.mock("./TableGrid", () => ({
  emptySelection: () => ({ columns: { toArray: () => [] }, rows: { toArray: () => [] } }),
  TableGrid: (p: { pendingIds?: Set<string> }) => (
    <div data-testid="grid" data-pending={[...(p.pendingIds ?? [])].join(",")} />
  ),
}));
vi.mock("@/review/useProposals", () => ({
  useProposals: () => ({
    proposals: [
      {
        id: "p1",
        kind: "rows",
        status: "pending",
        page_path: "Atlas",
        rows: {
          table: "Atlas/_data/expenses.csv",
          applied: false,
          ops: [{ op: "update", id: "a", values: { amount: 13 } }],
        },
      },
      { id: "p2", kind: "edit", status: "pending", page_path: "Atlas" },
    ],
  }),
}));

afterEach(cleanup);

it("lets pointer and clipboard events reach window, where the grid listens", async () => {
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "Atlas", onTreeChanged: () => {} }}>
      <TableViewBody
        id="b"
        props={{
          source: "_data/expenses.csv",
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
  const grid = await screen.findByTestId("grid");
  const seen: string[] = [];
  const types = ["mousedown", "mouseup", "mousemove", "click", "paste", "copy", "keydown"];
  const listeners = types.map((type) => {
    const listener = () => seen.push(type);
    window.addEventListener(type, listener);
    return [type, listener] as const;
  });
  fireEvent.mouseDown(grid);
  fireEvent.mouseUp(grid);
  fireEvent.mouseMove(grid);
  fireEvent.click(grid);
  fireEvent.paste(grid);
  fireEvent.copy(grid);
  fireEvent.keyDown(grid, { key: "a" });
  for (const [type, listener] of listeners) window.removeEventListener(type, listener);
  expect(seen).toEqual(types);
});

it("tints rows an AI proposal would change and says a review is waiting", async () => {
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "Atlas", onTreeChanged: () => {} }}>
      <TableViewBody
        id="b"
        props={{
          source: "_data/expenses.csv",
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
  expect((await screen.findByTestId("grid")).getAttribute("data-pending")).toBe("a");
  expect(screen.getByText("1 AI change to this table awaits review")).toBeTruthy();
});
