import { expect, it } from "vitest";
import { GridCellKind } from "@glideapps/glide-data-grid";
import type { TableColumn } from "@/lib/tables";
import { mix } from "./cells";
import { formatValue } from "./columns";
import { cellFor, valueOf } from "./TableGrid";

const col = (type: string, extra: Partial<TableColumn> = {}): TableColumn => ({
  name: "c",
  type,
  invalid: 0,
  wrap: false,
  ...extra,
});

it("mixes pill colors the way pages.css does", () => {
  expect(mix("#3e9470", 0.22, "rgba(255, 255, 255, 1)")).toBe("rgb(213, 231, 224)");
  expect(mix("#ffffff", 1, "#000000")).toBe("rgb(255, 255, 255)");
});

it("formats money, percentages and dates for display", () => {
  expect(formatValue(col("currency", { currency: "EUR" }), 12.5)).toMatch(/12[.,]50/);
  expect(formatValue(col("currency", { currency: "EUR" }), 12.5)).toContain("€");
  expect(formatValue(col("percent"), 25)).toBe("25%");
  expect(formatValue(col("date"), "2026-09-15")).toBe("September 15, 2026");
  expect(formatValue(col("multi_select"), ["a", "b"])).toBe("a, b");
});

it("turns select values into pill cells and back", () => {
  const cell = cellFor(col("multi_select", { options: ["a", "b"] }), ["a", "b"]);
  expect(cell.kind).toBe(GridCellKind.Custom);
  expect(valueOf(col("multi_select"), cell as never)).toEqual(["a", "b"]);
  const status = cellFor(col("status"), "Done");
  expect(valueOf(col("status"), status as never)).toBe("Done");
});

it("checks typed text before writing it", () => {
  const text = (data: string) => ({
    kind: GridCellKind.Text as const,
    data,
    displayData: data,
    allowOverlay: true,
  });
  expect(valueOf(col("currency"), text("€1,200.50"))).toBe(1200.5);
  expect(valueOf(col("date"), text("2026-10-01"))).toBe("2026-10-01");
  expect(valueOf(col("url"), text("example.com"))).toBe("https://example.com");
  expect(() => valueOf(col("email"), text("nope"))).toThrow(/email/);
  expect(() => valueOf(col("date"), text("someday maybe"))).toThrow(/date/);
  expect(() => valueOf(col("number"), text("abc"))).toThrow(/number/);
});

it("draws values that don't fit the type as red raw text, and checkboxes black and white", () => {
  const colors = {
    foreground: "rgb(0, 0, 0)",
    background: "rgb(255, 255, 255)",
    destructive: "red",
  };
  const bad = cellFor(col("number"), "abc", undefined, colors);
  expect(bad).toMatchObject({
    kind: GridCellKind.Text,
    data: "abc",
    themeOverride: { textDark: "red" },
  });
  expect(cellFor(col("date"), "next week", undefined, colors).kind).toBe(GridCellKind.Text);
  expect(cellFor(col("number"), 12, undefined, colors).kind).toBe(GridCellKind.Number);
  const box = cellFor(col("checkbox"), true, undefined, colors);
  expect(box).toMatchObject({
    kind: GridCellKind.Boolean,
    maxSize: 14,
    themeOverride: { textMedium: "rgb(0, 0, 0)", accentColor: "rgb(0, 0, 0)" },
  });
});

it("wraps text only in columns set to wrap", () => {
  expect(cellFor(col("text", { wrap: true }), "a long note")).toMatchObject({
    allowWrapping: true,
  });
  expect(cellFor(col("text"), "a long note")).toMatchObject({ allowWrapping: false });
});

it("turns relation links into pill cells and back into links", () => {
  const column = col("relation", { target: "Clients/_data/companies.csv", cardinality: "many" });
  const links = [
    { id: "c1", label: "Acme", secondary: "Utrecht" },
    { id: "c2", label: "", broken: true },
  ];
  const cell = cellFor(column, links);
  expect(cell.kind).toBe(GridCellKind.Custom);
  expect(cell.allowOverlay).toBe(true);
  expect(valueOf(column, cell as never)).toEqual([
    { id: "c1", label: "Acme" },
    { id: "c2", label: "" },
  ]);
  expect(formatValue(column, links)).toBe("Acme, Untitled");
  // Without a target table the cell cannot be edited.
  expect(cellFor(col("relation"), []).allowOverlay).toBe(false);
});
