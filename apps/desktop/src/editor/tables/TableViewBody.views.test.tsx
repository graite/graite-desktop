import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import { TableViewBody } from "./TableViewBody";

/** Named views (D79): tabs, a board of table rows, layouts, and the switch loader. */
const deals = {
  path: "CRM/Data/_data/deals.csv",
  page_path: "CRM/Data",
  name: "deals",
  hash: "h",
  row_count: 3,
  primary_key: "id",
  display: null,
  label_column: "name",
  columns: [
    { name: "id", type: "text", invalid: 0, wrap: false },
    { name: "name", type: "text", invalid: 0, wrap: false },
    {
      name: "stage",
      type: "status",
      options: ["Lead", "Won"],
      colors: { Lead: "gray", Won: "green" },
      invalid: 0,
      wrap: false,
    },
    { name: "value", type: "currency", currency: "EUR", invalid: 0, wrap: false },
  ],
  warnings: [],
};
const page = {
  ...deals,
  visible: ["id", "name", "stage", "value"],
  total: 3,
  offset: 0,
  rows: [
    { id: "a", cells: ["a", "Pilot", "Lead", 100] },
    { id: "b", cells: ["b", "Renewal", "Won", 900] },
    { id: "c", cells: ["c", "Audit", null, 50] },
  ],
};
const api = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ path: "CRM/Data/_data/deals.csv" })),
  list: vi.fn(async () => [deals]),
  rows: vi.fn(),
  write: vi.fn<
    (path: string, ops: unknown[]) => Promise<{ path: string; hash: string; ids: string[] }>
  >(async () => ({ path: "x", hash: "h2", ids: ["n"] })),
}));
vi.mock("@/lib/tables", async (orig) => ({
  ...(await orig<typeof import("@/lib/tables")>()),
  tables: api,
}));
vi.mock("./TableGrid", () => ({
  emptySelection: () => ({ columns: { toArray: () => [] }, rows: { toArray: () => [] } }),
  TableGrid: () => <div data-testid="grid" />,
}));
vi.mock("./RowPanel", () => ({
  RowPanel: ({ row }: { row: { id: string } | null }) =>
    row ? <div data-testid="row-panel">{row.id}</div> : null,
}));
vi.mock("@/review/useProposals", () => ({ useProposals: () => ({ proposals: [] }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const VIEWS = [
  {
    name: "Pipeline",
    source: "_data/deals.csv",
    view: "board",
    group: "stage",
    show: ["value"],
  },
  { name: "All deals", source: "_data/deals.csv", view: "table" },
];

function mount(views: unknown[] = VIEWS) {
  api.rows.mockResolvedValue(page);
  const updateBlock = vi.fn();
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "CRM/Data", onTreeChanged: () => {} }}>
      <TableViewBody
        id="b"
        props={{
          views: JSON.stringify(views),
          source: "",
          view: "",
          filter: "",
          sort: "",
          columns: "",
          height: 0,
          embed: false,
          tabs: "",
        }}
        editor={{ updateBlock } as unknown as GraiteEditor}
      />
    </MediaContext.Provider>,
  );
  const written = () =>
    JSON.parse(
      updateBlock.mock.calls[updateBlock.mock.calls.length - 1]![1].props.views as string,
    ) as Record<string, unknown>[];
  return { updateBlock, written };
}

it("shows a board of table rows in columns by the group's options", async () => {
  mount();
  await screen.findByText("Pilot");
  const columns = document.querySelectorAll(".view-column");
  // Lead, Won, then "No stage" for the row without one.
  expect([...columns].map((c) => c.querySelector(".view-column-header")!.textContent)).toEqual([
    expect.stringContaining("Lead"),
    expect.stringContaining("Won"),
    expect.stringContaining("No stage"),
  ]);
  // Cards show their fields formatted like the grid.
  expect(within(columns[1] as HTMLElement).getByText(/900/)).toBeTruthy();
  // A card opens its row.
  fireEvent.click(screen.getByText("Renewal"));
  expect((await screen.findByTestId("row-panel")).textContent).toBe("b");
});

it("moves a card to another column with one row update", async () => {
  mount();
  const card = (await screen.findByText("Pilot")).closest("article")!;
  const won = document.querySelectorAll(".view-column")[1]!;
  const data = new Map<string, string>();
  const dataTransfer = {
    types: ["application/graite-view-page"],
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    dropEffect: "",
    effectAllowed: "",
  };
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(won, { dataTransfer });
  fireEvent.drop(won, { dataTransfer });
  await vi.waitFor(() => expect(api.write).toHaveBeenCalled());
  expect(api.write.mock.calls[0]![1]).toEqual([
    { op: "update", id: "a", values: { stage: "Won" }, base: { stage: "Lead" } },
  ]);
});

it("switching views writes nothing; reordering and layout changes write the views", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { updateBlock, written } = mount();
  await screen.findByText("Pilot");
  fireEvent.click(screen.getByRole("tab", { name: "All deals" }));
  expect(updateBlock).not.toHaveBeenCalled();
  // A short loader shows the switch.
  expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  expect(await screen.findByTestId("grid")).toBeTruthy();

  // A new view is made in its layout: a board of deals by stage.
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  fireEvent.click(screen.getByRole("radio", { name: /Board/ }));
  expect(screen.getByRole("radio", { name: /stage/ }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Add view" }));
  await vi.waitFor(() => expect(updateBlock).toHaveBeenCalled());
  expect(written()[2]).toEqual({
    name: "Board",
    source: "_data/deals.csv",
    view: "board",
    group: "stage",
  });

  const data = new Map<string, string>();
  const dataTransfer = {
    types: ["application/graite-table-view"],
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    effectAllowed: "",
  };
  const tabs = within(screen.getByRole("tablist", { name: "Views" })).getAllByRole("tab");
  fireEvent.dragStart(tabs[1]!, { dataTransfer });
  fireEvent.drop(tabs[0]!, { dataTransfer });
  expect(written().map((v) => v.name)).toEqual(["All deals", "Pipeline"]);
});

it("chooses the card fields of a board view", async () => {
  const { written } = mount();
  await screen.findByText("Pilot");
  fireEvent.click(screen.getByRole("button", { name: "Shown fields" }));
  expect(screen.getByText(/Shown on cards/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Show stage" }));
  expect(written()[0]!.show).toEqual(["value", "stage"]);
});

it("adds views of the same table only, and gives a board a Status field when it has none", async () => {
  const plain = {
    ...deals,
    columns: deals.columns.filter((c) => c.name !== "stage"),
  };
  api.rows.mockResolvedValue({ ...page, ...plain, visible: ["id", "name", "value"] });
  const addStatusField = vi.fn(async () => "status");
  (api as Record<string, unknown>).addStatusField = addStatusField;
  const updateBlock = vi.fn();
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "CRM/Data", onTreeChanged: () => {} }}>
      <TableViewBody
        id="b"
        props={{
          views: JSON.stringify([{ name: "All deals", source: "_data/deals.csv" }]),
          source: "",
          view: "",
          filter: "",
          sort: "",
          columns: "",
          height: 0,
          embed: false,
          tabs: "",
        }}
        editor={{ updateBlock } as unknown as GraiteEditor}
      />
    </MediaContext.Provider>,
  );
  await screen.findByTestId("grid");
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  // One database per block (D82): the new view is of deals; there is no table to choose.
  expect(screen.getByText(/New view of/).textContent).toContain("deals");
  expect(screen.queryByRole("listbox", { name: /Table/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /Board/ }));
  expect(screen.getByText(/a Status field \(Todo, Doing, Done\) is added/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add view" }));
  await vi.waitFor(() => expect(updateBlock).toHaveBeenCalled());
  expect(addStatusField).toHaveBeenCalledTimes(1);
  const views = JSON.parse(updateBlock.mock.calls[0]![1].props.views as string) as unknown[];
  expect(views[1]).toEqual({
    name: "Board",
    source: "_data/deals.csv",
    view: "board",
    group: "status",
  });
});

it("sorts a board view from the toolbar", async () => {
  const { written } = mount();
  await screen.findByText("Pilot");
  fireEvent.click(screen.getByRole("button", { name: "Sort" }));
  fireEvent.click(screen.getByRole("option", { name: "value" }));
  expect(written()[0]!.sort).toBe("value asc");
});
