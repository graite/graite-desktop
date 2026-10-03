import { expect, it } from "vitest";
import type { TableInfo } from "@/lib/tables";
import { buildOption, formatNumber, headline, PALETTE } from "./option";
import { chartTitle, measureLabel, specToProps, toSpec, yList, type ChartProps } from "./spec";
import { defaultChart, numberFields, suggestions } from "./suggest";

const props = (over: Partial<ChartProps>): ChartProps => ({
  title: "",
  source: "",
  sql: "",
  type: "",
  x: "",
  y: "",
  series: "",
  filter: "",
  sort: "",
  limit: 0,
  stacked: "",
  height: 0,
  palette: "",
  ...over,
});

const colors = {
  foreground: "#111",
  muted: "#777",
  border: "#ddd",
  background: "#fff",
  font: "sans-serif",
};

const col = (name: string, type: string) => ({ name, type, invalid: 0, wrap: false });
const cars = {
  path: "Garage/_data/cars.csv",
  page_path: "Garage",
  name: "cars",
  hash: "h",
  row_count: 6,
  primary_key: "id",
  label_column: "name",
  columns: [
    col("id", "text"),
    col("name", "text"),
    col("test type", "multi_select"),
    col("status", "status"),
    col("rating", "number"),
  ],
} as unknown as TableInfo;

it("sends only the keys that are set; a field-less aggregate counts rows", () => {
  expect(toSpec(props({ source: "cars", x: "name", y: "rating", stacked: "true" }))).toEqual({
    source: "cars",
    x: "name",
    y: "rating",
    stacked: true,
  });
  expect(toSpec(props({ source: "cars", x: "rating", y: "sum()" }))).toEqual({
    source: "cars",
    x: "rating",
  });
  expect(yList('["rating","avg(price)"]')).toEqual(["rating", "avg(price)"]);
  expect(measureLabel("avg(price)")).toBe("Average price");
  expect(measureLabel("rating")).toBe("rating");
  expect(chartTitle(props({ x: "name", y: "rating" }))).toBe("rating by name");
  expect(chartTitle(props({ x: "status" }))).toBe("Count by status");
  expect(chartTitle(props({ type: "line", x: "month(date)", y: '["a","b"]' }))).toBe(
    "a and b per month",
  );
});

it("starts a chart of a table with something worth seeing", () => {
  expect(defaultChart("Garage", cars, [cars])).toEqual({
    source: "_data/cars.csv",
    type: "",
    x: "name",
    y: "rating",
  });
  const noNumbers = { ...cars, columns: cars.columns.filter((c) => c.name !== "rating") };
  expect(defaultChart("Garage", noNumbers, [noNumbers])).toMatchObject({ x: "status", y: "" });
  expect(numberFields(cars, [cars]).map((n) => n.key)).toEqual(["rating"]);
  const labels = suggestions("Garage", cars, [cars]).map((s) => s.label);
  expect(labels).toEqual([
    "rating by name",
    "Count by status",
    "Count by test type",
    "Average rating by status",
    "Total rating",
    "Number of rows",
  ]);
});

it("draws calm bars, restrained lines and clean donuts", () => {
  const data = {
    categories: ["Audi", "Tesla", "BMW"],
    series: [
      { name: "Done", data: [2, 5, 1], format: "number" },
      { name: "Open", data: [1, null, 3], format: "number" },
    ],
    points: [],
    tables: [],
    truncated: false,
    format: "number",
  };
  type Bars = {
    color: string[];
    series: { type: string; data: unknown[]; itemStyle: { borderRadius: unknown } }[];
    legend?: object;
  };
  const bar = buildOption("bar", data, colors) as Bars;
  expect(bar.series.map((s) => s.type)).toEqual(["bar", "bar"]);
  expect(bar.legend).toBeUndefined(); // the legend is HTML around the chart
  expect(bar.color).toEqual(PALETTE);
  // One series keeps one confident color instead of arbitrarily muting most categories.
  const single = buildOption("bar", { ...data, series: [data.series[0]!] }, colors) as Bars;
  expect(single.series[0]!.data).toEqual([2, 5, 1]);
  expect(single.series[0]!.itemStyle).toMatchObject({ color: "#0a0a0a" });
  // Dark mode takes the palette's dark shades.
  const dark = buildOption("bar", data, { ...colors, dark: true }, { palette: "mono" }) as Bars;
  expect(dark.color[0]).toBe("#ffffff");
  // A series switched off in the legend is left out.
  const hidden = buildOption("line", data, colors, { hidden: new Set(["Open"]) }) as Bars;
  expect(hidden.series.map((s) => (s as unknown as { name: string }).name)).toEqual(["Done"]);
  const donut = buildOption("donut", { ...data, series: [data.series[0]!] }, colors) as {
    series: {
      radius: string[];
      padAngle: number;
      itemStyle: { borderRadius: number; borderCap: string; borderJoin: string };
      emphasis: { scale: boolean; itemStyle: { borderRadius: number } };
      label: { show: boolean };
      data: { name: string }[];
    }[];
  };
  expect(donut.series[0]).toMatchObject({
    radius: ["58%", "82%"],
    padAngle: 0,
    itemStyle: { borderRadius: 0, borderCap: "butt", borderJoin: "miter" },
    emphasis: { scale: false, itemStyle: { borderRadius: 0 } },
    label: { show: false },
  });
  expect(donut.series[0]!.data.map((d) => d.name)).toEqual(["Audi", "Tesla", "BMW"]);
  const mini = buildOption("bar", data, colors, { mini: true }) as { tooltip: { show?: boolean } };
  expect(mini.tooltip.show).toBe(false);
  expect(formatNumber(1234.5, "currency:EUR")).toMatch(/1[,.]234[,.]50/);
  expect(formatNumber(25, "percent")).toBe("25%");
  expect(formatNumber(1_500_000, "number", true)).toMatch(/1[.,]5\s?M/);
});

it("puts the total (or the average) and the trend in the headline", () => {
  const base = {
    categories: ["a", "b", "c"],
    points: [],
    tables: [],
    truncated: false,
    format: "number",
  };
  expect(
    headline("bar", { ...base, series: [{ name: "rating", data: [1, 5, 2], format: "number" }] }),
  ).toEqual({
    value: 8,
    format: "number",
    change: null,
  });
  expect(
    headline("bar", {
      ...base,
      series: [{ name: "Average rating", data: [2, 4, null], format: "number" }],
    }).value,
  ).toBe(3);
  expect(
    headline("line", {
      ...base,
      series: [{ name: "x", data: [10, 12, 15], format: "currency:EUR" }],
    }),
  ).toEqual({ value: 37, format: "currency:EUR", change: 50 });
});

it("turns an AI spec into props, clearing what it leaves out", () => {
  expect(
    specToProps(
      { source: "cars", type: "bar", x: "name", y: ["rating"], stacked: true },
      {
        palette: "ocean",
        height: 400,
      },
    ),
  ).toMatchObject({
    source: "cars",
    type: "",
    x: "name",
    y: "rating",
    stacked: "true",
    palette: "ocean",
    height: 400,
    filter: "",
  });
  expect(specToProps({ source: "cars", x: "status", palette: "candy" }).palette).toBe("candy");
});
