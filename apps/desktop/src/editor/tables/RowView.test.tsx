import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { linkMode } from "./RowLinks";
import { openHit, OPEN_WIDTH } from "./TableGrid";
import { RowView } from "./RowView";

/** A row's panel and page (D80): linked rows as pills or a list, activities as a timeline. */
const col = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  invalid: 0,
  wrap: false,
  ...extra,
});
const link = (id: string, label: string) => ({ id, label });

const deal = {
  path: "CRM/_data/deals.csv",
  page_path: "CRM",
  name: "deals",
  hash: "h",
  row_count: 1,
  primary_key: "id",
  label_column: "name",
  role: null as string | null,
  columns: [
    col("id", "text"),
    col("name", "text"),
    col("company", "relation", { target: "CRM/_data/companies.csv", cardinality: "one" }),
    col("contacts", "relation", { target: "CRM/_data/contacts.csv" }),
    col("activities", "relation", {
      target: "CRM/_data/activities.csv",
      reverse: "deal",
      cardinality: "many",
    }),
  ],
  warnings: [],
  visible: ["id", "name", "company", "contacts", "activities"],
  total: 1,
  offset: 0,
  docs: [],
};
const contacts = ["Ann", "Bo", "Cy", "Di", "Ed"].map((n, i) => link(`c${i}`, n));

function page(meta: typeof deal, rows: { id: string; cells: unknown[] }[]) {
  return { ...meta, rows, total: rows.length };
}
const activities = {
  ...deal,
  path: "CRM/_data/activities.csv",
  name: "activities",
  label_column: "title",
  columns: [
    col("id", "text"),
    col("type", "single_select", { options: ["Call", "Email", "Task"] }),
    col("title", "text"),
    col("description", "text"),
    col("date", "date"),
    col("due", "date"),
    col("done", "checkbox"),
    col("company", "relation", { target: "CRM/_data/companies.csv", cardinality: "one" }),
    col("deal", "relation", { target: "CRM/_data/deals.csv", cardinality: "one" }),
  ],
  visible: ["id", "type", "title", "description", "date", "due", "done", "company", "deal"],
};
const people = {
  ...deal,
  path: "CRM/_data/contacts.csv",
  name: "contacts",
  columns: [col("id", "text"), col("name", "text"), col("role", "text")],
  visible: ["id", "name", "role"],
};

const api = vi.hoisted(() => ({ rows: vi.fn(), write: vi.fn(), schema: vi.fn() }));
vi.mock("@/lib/tables", async (orig) => ({
  ...(await orig<typeof import("@/lib/tables")>()),
  tables: api,
}));
vi.mock("./RowDocument", () => ({ RowDocument: () => <div data-testid="doc" /> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(contactLinks = contacts) {
  api.rows.mockImplementation(async (path: string) => {
    if (path === deal.path)
      return page(deal, [
        {
          id: "d1",
          cells: ["d1", "Pilot", [link("co1", "Acme")], contactLinks, [link("a1", "Kickoff")]],
        },
      ]);
    if (path === activities.path)
      return page(activities, [
        {
          id: "a1",
          cells: ["a1", "Call", "Kickoff", "We met", "2026-10-01", null, null, null, null],
        },
      ]);
    if (path === people.path)
      return page(
        people,
        contactLinks.map((c) => ({ id: c.id, cells: [c.id, c.label, "Buyer"] })),
      );
    return page({ ...deal, path, role: null }, []);
  });
  api.write.mockResolvedValue({ path: "x", hash: "h", ids: ["new"] });
  const onOpen = vi.fn();
  render(
    <RowView
      row={{ table: deal.path, id: "d1" }}
      layout="panel"
      heading={(label) => <h1>{label}</h1>}
      onOpen={onOpen}
    />,
  );
  return { onOpen };
}

it("shows a link field as pills, or as a list past three links or when asked", () => {
  const relation = col("x", "relation") as Parameters<typeof linkMode>[0];
  expect(linkMode(relation, 3)).toBe("pills");
  expect(linkMode(relation, 4)).toBe("list");
  expect(linkMode({ ...relation, panel: { as: "list" } }, 1)).toBe("list");
  expect(linkMode({ ...relation, panel: { as: "pills" } }, 9)).toBe("pills");
});

it("hits the hover Open button only at the cell's right edge", () => {
  expect(openHit(200, 200 - OPEN_WIDTH)).toBe(true);
  expect(openHit(200, 20)).toBe(false);
});

it("lists many links, with their fields, and opens one in the stack", async () => {
  const { onOpen } = mount();
  expect(await screen.findByRole("heading", { name: "Pilot" })).toBeTruthy();
  // Five contacts: a list section, not pills.
  const name = await screen.findByText("Cy");
  expect(name.closest(".row-links-row")!.textContent).toContain("Buyer");
  fireEvent.click(name);
  expect(onOpen).toHaveBeenCalledWith(people.path, "c2");
});

it("shows few links as pills", async () => {
  mount(contacts.slice(0, 2));
  await screen.findByRole("heading", { name: "Pilot" });
  expect(await screen.findByText("Ann")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Fields shown for contacts/ })).toBeNull();
});

it("switches a link field between pills and a list, and removes a link", async () => {
  api.schema.mockResolvedValue({});
  mount(contacts.slice(0, 2));
  await screen.findByText("Ann");
  fireEvent.click(screen.getAllByRole("button", { name: "Show as list" })[1]!);
  await vi.waitFor(() =>
    expect(api.schema).toHaveBeenCalledWith(deal.path, {
      columns: { contacts: { panel: { as: "list" } } },
    }),
  );
  cleanup();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Remove Cy from contacts" }));
  await vi.waitFor(() => expect(api.write).toHaveBeenCalled());
  const [path, ops] = api.write.mock.calls[0]!;
  expect(path).toBe(deal.path);
  expect(ops[0].values).toEqual({ contacts: ["c0", "c1", "c3", "c4"] });
});

it("deletes the open row after a second click", async () => {
  const onDeleted = vi.fn();
  api.rows.mockResolvedValue(page(deal, [{ id: "d1", cells: ["d1", "Pilot", null, [], []] }]));
  api.write.mockResolvedValue({ path: "x", hash: "h", ids: ["d1"] });
  render(
    <RowView
      row={{ table: deal.path, id: "d1" }}
      layout="page"
      heading={(label, _s, _p, actions) => (
        <header>
          <h1>{label}</h1>
          {actions}
        </header>
      )}
      onOpen={vi.fn()}
      onDeleted={onDeleted}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(api.write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Click again to delete" }));
  await vi.waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(api.write).toHaveBeenCalledWith(deal.path, [{ op: "delete", id: "d1", values: {} }]);
});
