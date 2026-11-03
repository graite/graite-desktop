import { expect, it } from "vitest";
import { GridCellKind } from "@glideapps/glide-data-grid";
import type { TableColumn } from "@/lib/tables";
import { mix } from "./cells";
import { formatValue, parseNumber, shortName } from "./columns";
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

it("shows fixed decimals when a numeric column sets them", () => {
  expect(formatValue(col("currency", { currency: "EUR", decimals: 0 }), 12.5)).not.toMatch(/[.,]5/);
  expect(formatValue(col("currency", { currency: "EUR", decimals: 3 }), 12.5)).toMatch(/12[.,]500/);
  expect(formatValue(col("number", { decimals: 2 }), 3)).toMatch(/^3[.,]00$/);
  expect(formatValue(col("percent", { decimals: 1 }), 25)).toMatch(/^25[.,]0%$/);
  const money = col("formula", { format: "currency", currency: "EUR", decimals: 0 });
  expect(formatValue(money, 99.9)).toContain("100");
});

it("formats money, percentages and dates for display", () => {
  expect(formatValue(col("currency", { currency: "EUR" }), 12.5)).toMatch(/12[.,]50/);
  expect(formatValue(col("currency", { currency: "EUR" }), 12.5)).toContain("€");
  expect(formatValue(col("percent"), 25)).toBe("25%");
  expect(formatValue(col("date"), "2026-09-15")).toBe("Sep 15, 2026");
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

it("shortens long file names in the middle, keeping the extension", () => {
  expect(shortName("receipt.pdf")).toBe("receipt.pdf");
  const short = shortName("Invoice-2026-0042-Acme-Consulting-Services-BV-final.pdf");
  expect(short.length).toBe(28);
  expect(short.startsWith("Invoice-2026-")).toBe(true);
  expect(short.endsWith("final.pdf")).toBe(true);
  expect(short).toContain("…");
  // No extension: still shortened to the limit.
  expect(shortName("a".repeat(60), 20)).toHaveLength(20);
});

it("draws formula cells as their format, read-only", () => {
  const money = col("formula", { format: "currency", currency: "EUR", formula: "net * 2" });
  const cell = cellFor(money, 12.5);
  expect(cell.kind).toBe(GridCellKind.Number);
  expect(cell.allowOverlay).toBe(false);
  expect("readonly" in cell && cell.readonly).toBe(true);
  expect(formatValue(money, 12.5)).toContain("€");
  const check = cellFor(col("formula", { format: "checkbox" }), true);
  expect(check.kind).toBe(GridCellKind.Boolean);
});

it("turns file and page cells into chips and back", () => {
  const files = [{ file: `${"0".repeat(32)}-scan.pdf`, name: "scan.pdf" }];
  const fileCell = cellFor(col("file"), files);
  expect(fileCell.kind).toBe(GridCellKind.Custom);
  expect(valueOf(col("file"), fileCell as never)).toEqual(files);
  expect(formatValue(col("file"), files)).toBe("scan.pdf");

  const linked = [{ path: "Clients/Acme", title: "Acme", icon: "🏢" }];
  const pageCell = cellFor(col("page"), linked);
  expect(valueOf(col("page"), pageCell as never)).toEqual([
    { path: "Clients/Acme", title: "Acme" },
  ]);
  expect(formatValue(col("page"), linked)).toBe("Acme");
});

it("reads typed and pasted numbers with either decimal mark", () => {
  // Both marks: the last one is the decimal point.
  expect(parseNumber("1.234,56", ".")).toBe(1234.56);
  expect(parseNumber("1,234.56", ",")).toBe(1234.56);
  // One mark that cannot be thousands: a decimal point, whatever the locale.
  expect(parseNumber("12,50", ".")).toBe(12.5);
  expect(parseNumber("€ 12,5", ".")).toBe(12.5);
  expect(parseNumber("0,21", ".")).toBe(0.21);
  // `1,500` is ambiguous: the locale decides.
  expect(parseNumber("1,500", ".")).toBe(1500);
  expect(parseNumber("1,500", ",")).toBe(1.5);
  expect(parseNumber("1.500.000", ",")).toBe(1500000);
  expect(parseNumber("25%", ".")).toBe(25);
  expect(parseNumber("(40,00)", ",")).toBe(-40);
  expect(parseNumber("-3", ".")).toBe(-3);
  expect(parseNumber("abc", ".")).toBeNull();
  expect(parseNumber("1,2,3.4.5", ".")).toBeNull();
});
