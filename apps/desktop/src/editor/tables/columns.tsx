import { Coins, FileText, Link2, Paperclip, Percent, Sigma, type LucideIcon } from "lucide-react";
import { formatDate } from "@/pages/DateField";
import { propertyIcons } from "@/pages/PageProperties";
import type { PageProperty, PropertyKind } from "@/lib/workspace";
import { isFileLinks, isPageLinks, isRelationLinks, type TableColumn } from "@/lib/tables";

/** The field types a table column can have, in menu order (D68). */
export const TABLE_TYPES = [
  ["text", "Text"],
  ["number", "Number"],
  ["currency", "Currency"],
  ["percent", "Percentage"],
  ["single_select", "Select"],
  ["multi_select", "Multi-select"],
  ["status", "Status"],
  ["date", "Date"],
  ["checkbox", "Checkbox"],
  ["url", "URL"],
  ["email", "Email"],
  ["relation", "Relation"],
  ["file", "Files"],
  ["page", "Page link"],
  ["formula", "Formula"],
] as const;
export type TableType = (typeof TABLE_TYPES)[number][0];

export const CURRENCIES = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "JPY",
  "CNY",
  "INR",
  "CAD",
  "AUD",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "BRL",
];

export const CHOICE_TYPES = ["single_select", "multi_select", "status"];
export const NUMERIC_TYPES = ["number", "currency", "percent"];

/** The page-property icon for a column type; the types pages don't have get their own. */
export function typeIcon(type: string): LucideIcon {
  if (type === "currency") return Coins;
  if (type === "percent") return Percent;
  if (type === "relation") return Link2;
  if (type === "formula") return Sigma;
  if (type === "file") return Paperclip;
  if (type === "page") return FileText;
  return propertyIcons[type as PropertyKind] ?? propertyIcons.text;
}

export function TypeIcon({ type, size = 15 }: { type: string; size?: number }) {
  const Icon = typeIcon(type);
  return <Icon size={size} />;
}

export function typeLabel(type: string): string {
  return TABLE_TYPES.find(([t]) => t === type)?.[1] ?? "Text";
}

/** How a formula's values show (D75). */
export const FORMULA_FORMATS = [
  ["number", "Number"],
  ["currency", "Currency"],
  ["percent", "Percentage"],
  ["date", "Date"],
  ["text", "Text"],
  ["checkbox", "Checkbox"],
] as const;

/** The column as its values read: a formula shows as its format, every other column as is. */
export function shownAs(column: TableColumn): TableColumn {
  return column.type === "formula" ? { ...column, type: column.format || "number" } : column;
}

/** A column as a page property, so the page views' pills, pickers and filters work on it. */
export function asProperty(column: TableColumn, value: PageProperty["value"] = null): PageProperty {
  column = shownAs(column);
  const type = (
    NUMERIC_TYPES.includes(column.type)
      ? "number"
      : ["relation", "file", "page"].includes(column.type)
        ? "text"
        : column.type
  ) as PropertyKind;
  return {
    id: column.name,
    name: column.name,
    type,
    options: column.options ?? [],
    colors: column.colors ?? {},
    value,
  };
}

function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(undefined, options);
  } catch {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 });
  }
}

/** Fixed decimals when the column sets them (D82), else what the value has. */
function places(column: TableColumn, fallback: number): Intl.NumberFormatOptions {
  const fixed = column.decimals;
  return typeof fixed === "number"
    ? { minimumFractionDigits: fixed, maximumFractionDigits: fixed }
    : { maximumFractionDigits: fallback };
}

/** A number as a column shows it: money with its currency, percentages with %. */
export function formatNumber(column: TableColumn, value: number): string {
  column = shownAs(column);
  if (column.type === "currency") {
    const money: Intl.NumberFormatOptions = {
      style: "currency",
      currency: column.currency || "EUR",
    };
    if (typeof column.decimals === "number") Object.assign(money, places(column, 2));
    return numberFormat(money).format(value);
  }
  if (column.type === "percent") return `${numberFormat(places(column, 4)).format(value)}%`;
  return numberFormat(places(column, 10)).format(value);
}

/** How a cell value reads in the grid. Money and percentages are plain numbers on disk. */
export function formatValue(column: TableColumn, value: unknown): string {
  column = shownAs(column);
  if (value === null || value === undefined || value === "") return "";
  if (isRelationLinks(value)) return value.map((link) => link.label || "Untitled").join(", ");
  if (isFileLinks(value)) return value.map((f) => f.name).join(", ");
  if (isPageLinks(value)) return value.map((p) => p.title || "Untitled").join(", ");
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return formatNumber(column, value);
  if (column.type === "date" && typeof value === "string") {
    const [day, time] = value.split("T");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return value;
    return time ? `${formatDate(day!)} ${time.slice(0, 5)}` : formatDate(day!);
  }
  return String(value);
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const URL_RE = /^https?:\/\/\S+$/i;

/** A long file name shortened in the middle, keeping its extension: `Invoice-2026-0…acme.pdf`. */
export function shortName(name: string, max = 28): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const stem = name.slice(0, name.length - ext.length);
  const room = Math.max(max - ext.length - 1, 4);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return `${stem.slice(0, head)}…${stem.slice(stem.length - tail)}${ext}`;
}

/** The decimal separator people type here ("," in Dutch, "." in English). */
function localeDecimal(): string {
  try {
    return (
      new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? "."
    );
  } catch {
    return ".";
  }
}

/** A typed or pasted number: `12,50`, `1.234,56`, `€ 1,234.50`, `25%`. With both separators the
 *  last one is the decimal point; with one, it is the decimal point unless it groups thousands
 *  (`1,500`), and then the locale decides. Null when the text is not a number. */
export function parseNumber(text: string, decimal: string = localeDecimal()): number | null {
  let t = text.replace(/[\s\u00a0%€$£¥]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!t) return null;
  const comma = t.lastIndexOf(",");
  const dot = t.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const point = comma > dot ? "," : ".";
    t = t
      .split(point === "," ? "." : ",")
      .join("")
      .replace(point, ".");
  } else if (comma >= 0 || dot >= 0) {
    const mark = comma >= 0 ? "," : ".";
    const grouped = new RegExp(`^-?\\d{1,3}(\\${mark}\\d{3})+$`).test(t);
    const several = t.split(mark).length > 2;
    if (several || (grouped && mark !== decimal)) t = t.split(mark).join("");
    else t = t.replace(mark, ".");
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
