import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MediaContext } from "../media/context";
import { DatabaseSetup } from "./DatabaseSetup";
import { startSetup } from "./setup";

const info = (page_path: string, name: string, columns: string[] = ["id", "name"]) => ({
  path: `${page_path}/_data/${name}.csv`,
  page_path,
  name,
  row_count: 1,
  columns: columns.map((c) => ({ name: c, type: "text" })),
});
const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addStatusField: vi.fn(async () => "status"),
}));
vi.mock("@/lib/tables", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tables")>()),
  tables: api,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(id: string) {
  const onViews = vi.fn();
  const onTreeChanged = vi.fn();
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "CRM/Contacts", onTreeChanged }}>
      <DatabaseSetup blockId={id} onViews={onViews} />
    </MediaContext.Provider>,
  );
  return { onViews };
}

it("makes a new database here as a board, with a Status field to group by", async () => {
  api.create.mockResolvedValue(info("CRM/Contacts", "books"));
  const { onViews } = setup("a");
  fireEvent.change(screen.getByLabelText("Database name"), { target: { value: "books" } });
  fireEvent.click(screen.getByRole("radio", { name: /Board/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(onViews).toHaveBeenCalled());
  expect(api.create).toHaveBeenCalledWith("CRM/Contacts", "books", ["name", "notes"]);
  expect(api.addStatusField).toHaveBeenCalledTimes(1);
  expect(onViews).toHaveBeenCalledWith([
    { name: "Board", source: "_data/books.csv", view: "board", group: "status" },
  ]);
});

it("links an existing database, nearest first", async () => {
  api.list.mockResolvedValue([
    info("Books", "books"),
    info("CRM", "deals", ["id", "name", "stage"]),
    info("CRM/Contacts", "contacts"),
  ]);
  startSetup("c", "linked");
  const { onViews } = setup("c");
  const list = await screen.findByRole("listbox", { name: "Database" });
  // This page, then the rest of the CRM; other pages wait behind "Show all".
  expect(
    within(list)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual([expect.stringContaining("contacts"), expect.stringContaining("deals")]);
  expect(within(list).getByText(/Show all databases \(1 more\)/)).toBeTruthy();
  fireEvent.click(within(list).getByRole("option", { name: /deals/ }));
  fireEvent.click(screen.getByRole("radio", { name: /List/ }));
  fireEvent.click(screen.getByRole("button", { name: "Show list" }));
  await vi.waitFor(() => expect(onViews).toHaveBeenCalled());
  expect(onViews).toHaveBeenCalledWith([
    { name: "List", source: "CRM/_data/deals.csv", view: "list" },
  ]);
});
