import { propertyTypes, type PageProperty, type PropertyKind } from "@/lib/workspace";
import type { PageDoc } from "@/lib/api";
import { findField } from "./collection";

export type ViewFilter = {
  field: string;
  op: "contains" | "equals" | "not" | "empty" | "filled" | "gt" | "lt";
  value: string;
};
export type ViewSettings = {
  fields?: PageProperty[];
  boards?: Record<string, { order: string[]; hidden: string[] }>;
  sort?: { field: string; direction: "asc" | "desc" };
  filters?: ViewFilter[];
};
export function readSettings(raw = ""): ViewSettings {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ViewSettings = {};
    if (Array.isArray(value.fields))
      result.fields = value.fields.flatMap((field: Partial<PageProperty>, index: number) => {
        if (
          !field ||
          typeof field.name !== "string" ||
          !field.name.trim() ||
          typeof field.type !== "string" ||
          !Object.prototype.hasOwnProperty.call(propertyTypes, field.type)
        )
          return [];
        const options = Array.isArray(field.options)
          ? field.options.filter((o): o is string => typeof o === "string" && !!o.trim())
          : [];
        return [
          {
            id: `view-field-${index}`,
            name: field.name.trim(),
            type: field.type as PropertyKind,
            options,
            colors: field.colors ?? {},
            value: field.type === "checkbox" ? false : field.type === "multi_select" ? [] : null,
          },
        ];
      });
    if (
      value.sort &&
      typeof value.sort.field === "string" &&
      ["asc", "desc"].includes(value.sort.direction)
    )
      result.sort = value.sort;
    if (Array.isArray(value.filters))
      result.filters = value.filters.filter(
        (f: ViewFilter) =>
          f &&
          typeof f.field === "string" &&
          typeof f.value === "string" &&
          ["contains", "equals", "not", "empty", "filled", "gt", "lt"].includes(f.op),
      );
    if (value.boards && typeof value.boards === "object" && !Array.isArray(value.boards)) {
      result.boards = Object.create(null);
      for (const [name, board] of Object.entries(value.boards)) {
        if (!board || typeof board !== "object") continue;
        const entry = board as { order?: unknown; hidden?: unknown };
        result.boards![name] = {
          order: Array.isArray(entry.order)
            ? entry.order.filter((v): v is string => typeof v === "string")
            : [],
          hidden: Array.isArray(entry.hidden)
            ? entry.hidden.filter((v): v is string => typeof v === "string")
            : [],
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}
export function moveName(names: string[], source: string, target: string): string[] {
  if (source === target || !names.includes(source) || !names.includes(target)) return names;
  const next = names.filter((n) => n !== source);
  next.splice(names.indexOf(target), 0, source);
  return next;
}
export function orderedNames(names: string[], order: string[] = []): string[] {
  return [...new Set([...order.filter((n) => names.includes(n)), ...names])];
}
export function rowValue(row: PageDoc, field: string): unknown {
  if (field === "$title") return row.title;
  const property = findField(row, field);
  if (property?.type === "created" || property?.type === "updated")
    return row.frontmatter[property.type];
  return property?.value;
}
const text = (value: unknown) =>
  (Array.isArray(value) ? value.join(", ") : String(value ?? "")).toLocaleLowerCase();
const empty = (value: unknown) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return text(a).localeCompare(text(b), undefined, { numeric: true });
}
export function projectRows(
  rows: PageDoc[],
  query: string,
  settings: ViewSettings,
  sorted: boolean,
): PageDoc[] {
  const result = rows.filter((row) => {
    if (query.trim() && !text(row.title).includes(query.trim().toLocaleLowerCase())) return false;
    return (settings.filters ?? []).every((filter) => {
      const value = rowValue(row, filter.field);
      const term = filter.value.toLocaleLowerCase();
      switch (filter.op) {
        case "empty":
          return empty(value);
        case "filled":
          return !empty(value);
        case "equals":
          return Array.isArray(value) ? value.some((v) => text(v) === term) : text(value) === term;
        case "not":
          return Array.isArray(value) ? value.every((v) => text(v) !== term) : text(value) !== term;
        case "gt":
          return (
            !empty(value) &&
            compareValues(value, typeof value === "number" ? Number(filter.value) : filter.value) >
              0
          );
        case "lt":
          return (
            !empty(value) &&
            compareValues(value, typeof value === "number" ? Number(filter.value) : filter.value) <
              0
          );
        default:
          return text(value).includes(term);
      }
    });
  });
  if (sorted && settings.sort) {
    const sort = settings.sort;
    result.sort((a, b) => {
      const av = rowValue(a, sort.field),
        bv = rowValue(b, sort.field);
      if (empty(av) || empty(bv)) return Number(empty(av)) - Number(empty(bv));
      return compareValues(av, bv) * (sort.direction === "asc" ? 1 : -1);
    });
  }
  return result;
}
