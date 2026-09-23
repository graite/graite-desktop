import type { PageDoc } from "@/lib/api";
import { pageProperties, type PageProperty } from "@/lib/workspace";

export type ViewKind = "table" | "kanban" | "list";
export const viewKinds: ViewKind[] = ["table", "kanban", "list"];
export const viewLabels: Record<ViewKind, string> = {
  table: "Table",
  kanban: "Board",
  list: "List",
};

export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The property a page stores under this name, if any. Names are matched case-insensitively. */
export function findField(row: PageDoc, name: string): PageProperty | undefined {
  return pageProperties(row).find((p) => sameName(p.name, name));
}

/**
 * The view's schema: every property name seen on the child pages, in first-seen order, with
 * options unioned (first-seen order) and colors merged (first definition wins). Values are
 * cleared: a merged field is a definition, not a page value.
 */
export function mergeFields(rows: PageDoc[]): PageProperty[] {
  const merged = new Map<string, PageProperty>();
  for (const row of rows) {
    for (const p of pageProperties(row)) {
      const key = p.name.trim().toLowerCase();
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...p,
          name: p.name.trim(),
          options: [...p.options],
          colors: { ...p.colors },
          value: null,
        });
        continue;
      }
      for (const option of p.options)
        if (!existing.options.includes(option)) existing.options.push(option);
      existing.colors = { ...p.colors, ...existing.colors };
    }
  }
  return [...merged.values()];
}

export const groupCandidates = (fields: PageProperty[]) =>
  fields.filter((f) => f.type === "status" || f.type === "single_select");

/**
 * `show` block prop: "" or a JSON object mapping a view kind to the property names that view
 * displays. A kind with no entry uses its default (table: all, board and list: none).
 */
export type ShowMap = Partial<Record<ViewKind, string[]>>;
export function parseShow(show: string): ShowMap {
  if (!show) return {};
  try {
    const parsed: unknown = JSON.parse(show);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: ShowMap = {};
    for (const kind of viewKinds) {
      const names = (parsed as Record<string, unknown>)[kind];
      if (Array.isArray(names)) map[kind] = names.map(String);
    }
    return map;
  } catch {
    return {};
  }
}
export function stringifyShow(map: ShowMap): string {
  const ordered: ShowMap = {};
  for (const kind of viewKinds) if (map[kind]) ordered[kind] = map[kind];
  return Object.keys(ordered).length ? JSON.stringify(ordered) : "";
}
/** The `show` prop with only this view's list replaced. */
export const withShown = (show: string, view: ViewKind, names: string[]) =>
  stringifyShow({ ...parseShow(show), [view]: names });

export function visibleFields(
  fields: PageProperty[],
  show: string,
  view: ViewKind,
): PageProperty[] {
  const names = parseShow(show)[view];
  if (names === undefined) return view === "table" ? fields : [];
  return names.flatMap((n) => {
    const field = fields.find((f) => sameName(n, f.name));
    return field ? [field] : [];
  });
}

/** The value a freshly added property gets on a page. */
export function emptyValue(field: PageProperty): PageProperty["value"] {
  return field.type === "checkbox" ? false : field.type === "multi_select" ? [] : null;
}

/** A page's value for a merged field, as a display string list (select values, text, etc.). */
export function groupValue(row: PageDoc, field: PageProperty): string {
  const value = findField(row, field.name)?.value;
  return typeof value === "string" ? value : "";
}
