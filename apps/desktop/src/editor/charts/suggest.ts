import { sourceFor, type TableColumn, type TableInfo } from "@/lib/tables";
import type { ChartProps } from "./spec";

/** Field types whose values a chart adds up. */
export const NUMBER_TYPES = ["number", "currency", "percent"];
/** Field types that group rows well, best first. */
const GROUPING = ["status", "single_select", "multi_select", "checkbox"];

export interface NumberField {
  /** As the fence names it: `rating`, or `owner.salary` through a relation. */
  key: string;
  label: string;
  column: TableColumn;
}

export interface Suggestion {
  label: string;
  type: string;
  patch: Partial<ChartProps>;
}

const isNumber = (c: TableColumn) => NUMBER_TYPES.includes(c.type);

/** The number fields a chart of `table` can show: its own, then those of linked tables. */
export function numberFields(table: TableInfo, tables: TableInfo[]): NumberField[] {
  const own = table.columns
    .filter((c) => isNumber(c) && c.name !== table.primary_key)
    .map((c) => ({ key: c.name, label: c.name, column: c }));
  const linked = table.columns
    .filter((c) => c.type === "relation" && !c.reverse && c.cardinality === "one" && c.target)
    .flatMap((rel) => {
      const target = tables.find((t) => t.path === rel.target);
      return (target?.columns ?? [])
        .filter((c) => isNumber(c))
        .map((c) => ({
          key: `${rel.name}.${c.name}`,
          label: `${rel.name} → ${c.name}`,
          column: c,
        }));
    });
  return [...own, ...linked];
}

/** The field that names a table's rows (its display field, else the first text field). */
export function nameField(table: TableInfo): string | null {
  if (table.label_column) return table.label_column;
  return table.columns.find((c) => c.type === "text" && c.name !== table.primary_key)?.name ?? null;
}

function dateField(table: TableInfo): string | null {
  return table.columns.find((c) => c.type === "date")?.name ?? null;
}

function groupingFields(table: TableInfo): string[] {
  const out: string[] = [];
  for (const type of GROUPING)
    for (const c of table.columns) if (c.type === type && !out.includes(c.name)) out.push(c.name);
  for (const c of table.columns)
    if (c.type === "relation" && !c.reverse && !out.includes(c.name)) out.push(c.name);
  return out;
}

/** A chart worth showing the moment a table is chosen: each row's first number by its name
 *  (or over time), else a count by the first grouping field. */
export function defaultChart(
  pagePath: string,
  table: TableInfo,
  tables: TableInfo[],
): Partial<ChartProps> {
  const source = sourceFor(pagePath, table);
  const number = numberFields(table, tables)[0]?.key;
  const name = nameField(table);
  const date = dateField(table);
  const group = groupingFields(table)[0];
  if (number && date) return { source, type: "line", x: `month(${date})`, y: number };
  if (number && name) return { source, type: "", x: name, y: number };
  if (group) return { source, type: "", x: group, y: "" };
  if (name) return { source, type: "", x: name, y: "" };
  return { source, type: "number", x: "", y: "" };
}

/** Up to six one-click charts for a table, from its field types. */
export function suggestions(pagePath: string, table: TableInfo, tables: TableInfo[]): Suggestion[] {
  const source = sourceFor(pagePath, table);
  const numbers = numberFields(table, tables).map((n) => n.key);
  const name = nameField(table);
  const date = dateField(table);
  const groups = groupingFields(table);
  const out: Suggestion[] = [];
  const add = (label: string, type: string, patch: Partial<ChartProps>) => {
    if (out.length < 6 && !out.some((s) => s.label === label))
      out.push({
        label,
        type: type || "bar",
        patch: { source, sql: "", series: "", filter: "", sort: "", type, ...patch },
      });
  };
  const n = numbers[0];
  if (n && date) add(`${n} over time`, "line", { x: `month(${date})`, y: n });
  if (n && name) add(`${n} by ${name}`, "", { x: name, y: n });
  for (const g of groups.slice(0, 2))
    add(`Count by ${g}`, groups.indexOf(g) === 0 ? "donut" : "", { x: g, y: "" });
  if (n && groups[0]) add(`Average ${n} by ${groups[0]}`, "", { x: groups[0], y: `avg(${n})` });
  if (numbers.length > 1 && name)
    add(`${numbers[0]} and ${numbers[1]} by ${name}`, "", {
      x: name,
      y: JSON.stringify(numbers.slice(0, 2)),
    });
  if (n) add(`Total ${n}`, "number", { x: "", y: n });
  if (!n && date) add("Rows per month", "line", { x: `month(${date})`, y: "" });
  add("Number of rows", "number", { x: "", y: "" });
  return out;
}
