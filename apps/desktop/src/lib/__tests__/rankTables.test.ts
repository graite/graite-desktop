import { expect, it } from "vitest";
import { rankTables, type TableInfo } from "@/lib/tables";

const t = (page_path: string, name: string) =>
  ({ path: `${page_path}/_data/${name}.csv`, page_path, name }) as TableInfo;

it("lists this page's tables, then its top-level page's (closest first), then the rest", () => {
  const list = [
    t("Books", "books"),
    t("CRM", "deals"),
    t("CRM/Deals", "notes"),
    t("CRM/Contacts/People", "people"),
    t("CRM/Contacts", "contacts"),
    t("Archive", "old"),
  ];
  const groups = rankTables(list, "CRM/Contacts");
  expect(groups.map((g) => [g.key, g.label, g.tables.map((x) => x.name)])).toEqual([
    ["here", "On this page", ["contacts"]],
    ["near", "In CRM", ["deals", "people", "notes"]],
    ["other", "Other pages", ["old", "books"]],
  ]);
});

it("leaves out empty groups", () => {
  expect(rankTables([t("A", "x")], "A").map((g) => g.key)).toEqual(["here"]);
});
