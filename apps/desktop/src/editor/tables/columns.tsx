import { Coins, Link2, Percent, type LucideIcon } from "lucide-react";
import { formatDate } from "@/pages/DateField";
import { propertyIcons } from "@/pages/PageProperties";
import type { PageProperty, PropertyKind } from "@/lib/workspace";
import { isRelationLinks, type TableColumn } from "@/lib/tables";

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
  return propertyIcons[type as PropertyKind] ?? propertyIcons.text;
}

export function TypeIcon({ type, size = 15 }: { type: string; size?: number }) {
  const Icon = typeIcon(type);
  return <Icon size={size} />;
}

export function typeLabel(type: string): string {
  return TABLE_TYPES.find(([t]) => t === type)?.[1] ?? "Text";
}

/** A column as a page property, so the page views' pills, pickers and filters work on it. */
export function asProperty(column: TableColumn, value: PageProperty["value"] = null): PageProperty {
  const type = (
    NUMERIC_TYPES.includes(column.type)
      ? "number"
      : column.type === "relation"
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

/** How a cell value reads in the grid. Money and percentages are plain numbers on disk. */
export function formatValue(column: TableColumn, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (isRelationLinks(value)) return value.map((link) => link.label || "Untitled").join(", ");
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") {
    if (column.type === "currency")
      return numberFormat({ style: "currency", currency: column.currency || "EUR" }).format(value);
    if (column.type === "percent")
      return `${numberFormat({ maximumFractionDigits: 4 }).format(value)}%`;
    return numberFormat({ maximumFractionDigits: 10 }).format(value);
  }
  if (column.type === "date" && typeof value === "string") {
    const [day, time] = value.split("T");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return value;
    return time ? `${formatDate(day!)} ${time.slice(0, 5)}` : formatDate(day!);
  }
  return String(value);
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const URL_RE = /^https?:\/\/\S+$/i;
