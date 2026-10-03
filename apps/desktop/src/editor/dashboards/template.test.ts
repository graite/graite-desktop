import { expect, it } from "vitest";
import type { TableInfo } from "@/lib/tables";
import { starterDashboard } from "./template";

const table = {
  path: "Garage/_data/cars.csv",
  page_path: "Garage",
  name: "cars",
  hash: "hash",
  row_count: 6,
  primary_key: "id",
  label_column: "name",
  columns: [
    { name: "id", type: "text", invalid: 0, wrap: false },
    { name: "name", type: "text", invalid: 0, wrap: false },
    { name: "status", type: "status", invalid: 0, wrap: false },
    { name: "rating", type: "number", invalid: 0, wrap: false },
  ],
} as unknown as TableInfo;

it("builds a live dashboard from the page's actual fields", () => {
  const result = starterDashboard("Garage overview", "Garage", [table]);
  expect(result).toContain("Live overview from 1 table");
  expect(result).toContain('"type": "number"');
  expect(result).toContain('"y": "avg(rating)"');
  expect(result).toContain('"type": "donut"');
  expect(result).toContain('"x": "status"');
  expect(result).toContain('"y": "rating"');
  expect(result).toContain("graite.chart");
  expect(result).not.toContain("graite.query");
});

it("keeps dashboard names and schema labels inert inside HTML and scripts", () => {
  const unsafe = {
    ...table,
    name: "</script><b>cars</b>",
    path: "Garage/_data/unsafe.csv",
    columns: table.columns.map((column) =>
      column.name === "status" ? { ...column, name: "</script>status" } : column,
    ),
  } as unknown as TableInfo;
  const result = starterDashboard("A & <B>", "Garage", [unsafe]);
  expect(result).toContain("A &amp; &lt;B&gt;");
  expect(result).toContain("\\u003c/script>status");
  expect(result).not.toContain('"x": "</script>status"');
});

it("shows a useful empty state when the page has no data yet", () => {
  const result = starterDashboard("Overview", "Empty", [table]);
  expect(result).toContain("No data yet");
  expect(result).toContain("Add a table to this page to populate the dashboard");
  expect(result).toContain("const METRICS = []");
});
