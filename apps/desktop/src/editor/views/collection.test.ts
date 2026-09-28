import { expect, it } from "vitest";
import type { PageDoc } from "@/lib/api";
import type { PageProperty } from "@/lib/workspace";
import { visibleFields } from "./collection";
import { viewSchema } from "./useViewSchema";

const field = (name: string): PageProperty => ({
  id: name,
  name,
  type: "text",
  options: [],
  colors: {},
  value: null,
});
const fields = ["Status", "Due", "Owner"].map(field);
const names = (list: PageProperty[]) => list.map((f) => f.name);

it("shows every property on every kind of view by default", () => {
  for (const view of ["table", "kanban", "list"] as const)
    expect(names(visibleFields(fields, "", view))).toEqual(["Status", "Due", "Owner"]);
});

it("uses show only for the order, so a property added later still appears", () => {
  const show = JSON.stringify({ kanban: ["Owner", "Due"] });
  expect(names(visibleFields(fields, show, "kanban"))).toEqual(["Owner", "Due", "Status"]);
});

it("leaves out the properties the view hides", () => {
  const show = JSON.stringify({ list: ["Owner"] });
  expect(names(visibleFields(fields, show, "list", ["status", "Due"]))).toEqual(["Owner"]);
});

const page = (title: string, props: PageProperty[]): PageDoc => ({
  id: title,
  title,
  path: `Board/${title}`,
  icon: null,
  hash: "",
  body: "",
  frontmatter: { properties: props },
});

it("gives a view's pages the union of their properties plus the view's own fields", () => {
  const board = [
    "```graite:view",
    "settings:",
    "  fields:",
    "    - name: Priority",
    "      type: single_select",
    "      options: [High, Low]",
    "view: kanban",
    "```",
    "",
  ].join("\n");
  const schema = viewSchema(board, [page("A", [field("Due")]), page("B", [field("Owner")])]);
  expect(names(schema)).toEqual(["Due", "Owner", "Priority"]);
  expect(schema.every((f) => f.value === null || f.type === "single_select")).toBe(true);
});
