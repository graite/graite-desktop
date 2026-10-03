import type { ChartSpec } from "@/lib/charts";

/** The chart block's props: the fence's keys as text ("" = absent), see md-convert ChartBlock. */
export interface ChartProps {
  title: string;
  source: string;
  sql: string;
  type: string;
  x: string;
  y: string;
  series: string;
  filter: string;
  sort: string;
  limit: number;
  stacked: string;
  height: number;
  /** mono/grayscale (default when ""), vivid, ocean, sunset, forest or candy. */
  palette: string;
}

export const EMPTY_CHART: ChartProps = {
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
};

/** Block props for a whole spec (from AI or a suggestion): every other key is cleared. */
export function specToProps(
  spec: Record<string, unknown>,
  keep: Partial<ChartProps> = {},
): ChartProps {
  const text = (k: string) => (typeof spec[k] === "string" ? (spec[k] as string) : "");
  const y = spec.y;
  return {
    ...EMPTY_CHART,
    height: keep.height ?? 0,
    palette: text("palette") || keep.palette || "",
    title: text("title"),
    source: text("source"),
    sql: text("sql"),
    type: text("type") === "bar" ? "" : text("type"),
    x: text("x"),
    y: Array.isArray(y) ? (y.length === 1 ? String(y[0]) : JSON.stringify(y)) : text("y"),
    series: text("series"),
    filter: text("filter"),
    sort: text("sort"),
    limit: typeof spec.limit === "number" ? spec.limit : 0,
    stacked: spec.stacked === true ? "true" : "",
  };
}

export const CHART_TYPES = [
  ["bar", "Bar"],
  ["line", "Line"],
  ["area", "Area"],
  ["pie", "Pie"],
  ["donut", "Donut"],
  ["scatter", "Scatter"],
  ["number", "Number"],
] as const;
export type ChartType = (typeof CHART_TYPES)[number][0];

/** The y values: a JSON list or one value; count when absent. */
export function yList(y: string): string[] {
  if (!y) return [];
  if (y.startsWith("[")) {
    try {
      return (JSON.parse(y) as unknown[]).map(String);
    } catch {
      return [y];
    }
  }
  return [y];
}

/** The spec the daemon draws from these props: only keys that are set. */
export function toSpec(p: ChartProps): ChartSpec {
  const spec: ChartSpec = {};
  if (p.sql) spec.sql = p.sql;
  else if (p.source) spec.source = p.source;
  if (p.type) spec.type = p.type;
  if (!p.sql) {
    if (p.x) spec.x = p.x;
    // An aggregate saved without its field (`sum()`) counts rows until a field is picked.
    const ys = yList(p.y).filter((y) => !/^\s*(sum|avg|min|max)\s*\(\s*\)\s*$/i.test(y));
    if (ys.length) spec.y = ys.length === 1 ? ys[0]! : ys;
    if (p.series) spec.series = p.series;
    if (p.filter) spec.filter = p.filter;
  }
  if (p.sort) spec.sort = p.sort;
  if (p.limit) spec.limit = p.limit;
  if (p.stacked) spec.stacked = p.stacked === "true";
  if (p.palette) spec.palette = p.palette;
  return spec;
}

/** A value as words: `sum(amount)` -> "Total amount", `rating` -> "rating", `count` -> "Count". */
export function measureLabel(y: string): string {
  const m = /^\s*(count|sum|avg|min|max)\s*(?:\(\s*(.*?)\s*\))?\s*$/i.exec(y);
  if (!m) return y.replace(".", " → ");
  const word = { count: "Count", sum: "Total", avg: "Average", min: "Minimum", max: "Maximum" }[
    m[1]!.toLowerCase() as "count"
  ];
  return m[2] ? `${word} ${m[2].replace(".", " → ")}` : word;
}

/** How a field reads in a title: `month(date)` -> "month", `owner.city` -> "owner city". */
function axisWords(x: string): string {
  const bucket = /^(day|week|month|quarter|year)\((.+)\)$/.exec(x);
  if (bucket) return bucket[1]!;
  return x.replace(".", " ");
}

/** The title a chart gets when its fence has none: "rating by name", "Count by status". */
export function chartTitle(p: ChartProps): string {
  if (p.title) return p.title;
  if (p.sql) return "Chart";
  const values = yList(p.y).filter((y) => !/\(\s*\)\s*$/.test(y));
  const what = values.length ? values.map(measureLabel).join(" and ") : "Count";
  if ((p.type || "bar") === "number") return what;
  if (!p.x) return what;
  const along = /^(day|week|month|quarter|year)\(/.test(p.x)
    ? ` per ${axisWords(p.x)}`
    : ` by ${axisWords(p.x)}`;
  const split = p.series ? `, split by ${axisWords(p.series)}` : "";
  return `${what}${along}${split}`;
}
