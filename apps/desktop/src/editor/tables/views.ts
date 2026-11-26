/**
 * Named views of a table block (D79): each shows one table of the database as a table, a board
 * or a list, with its own filter, sort, grouping and shown fields. Stored as the fence's
 * `views:` list (the block's `views` prop holds it as JSON).
 */
export type TableLayout = "table" | "board" | "list";
export const TABLE_LAYOUTS: [TableLayout, string][] = [
  ["table", "Table"],
  ["board", "Board"],
  ["list", "List"],
];

export interface TableViewDef {
  name: string;
  /** The table, as a fence's `source:` names it (`_data/deals.csv`, or a vault path). */
  source: string;
  view?: TableLayout;
  /** Board: the status or select column whose options are the columns. */
  group?: string;
  filter?: string;
  sort?: string | string[];
  /** Table: the columns shown, in order. */
  columns?: string[];
  /** Board and list: the fields each card or row shows, in order. */
  show?: string[];
  boards?: { order?: string[]; hidden?: string[] };
}

export function parseViews(json: string): TableViewDef[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v): v is TableViewDef =>
        !!v &&
        typeof v === "object" &&
        typeof (v as TableViewDef).name === "string" &&
        typeof (v as TableViewDef).source === "string",
    );
  } catch {
    return [];
  }
}

/** A view as written: keys in a fixed order, empty ones left out. */
export function cleanView(view: TableViewDef): TableViewDef {
  const out: TableViewDef = { name: view.name, source: view.source };
  if (view.view && view.view !== "table") out.view = view.view;
  else if (view.view === "table") out.view = "table";
  if (view.group) out.group = view.group;
  if (view.filter) out.filter = view.filter;
  if (view.sort && (typeof view.sort === "string" || view.sort.length)) out.sort = view.sort;
  if (view.columns) out.columns = view.columns;
  if (view.show) out.show = view.show;
  const order = view.boards?.order?.length ? view.boards.order : undefined;
  const hidden = view.boards?.hidden?.length ? view.boards.hidden : undefined;
  if (order || hidden) out.boards = { ...(order ? { order } : {}), ...(hidden ? { hidden } : {}) };
  return out;
}

/** A name not used by another view: "Board", "Board 2", ... */
export function freeName(views: TableViewDef[], base: string): string {
  const taken = new Set(views.map((v) => v.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Move the view at `from` to where `to` is. */
export function moveView(views: TableViewDef[], from: number, to: number): TableViewDef[] {
  const next = [...views];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** Whether a filter or sort text names this field (as a whole word, or quoted). */
function mentions(text: string, field: string): boolean {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "u").test(text);
}

function sortField(entry: string): string {
  return entry
    .trim()
    .replace(/^-/, "")
    .replace(/\s+(asc|desc)$/i, "");
}

/** A view's sort after a field was renamed (`to`) or deleted (`to` null). */
export function sortAfter(
  sort: string | string[] | undefined,
  from: string,
  to: string | null,
): string | string[] | undefined {
  if (!sort) return sort;
  const fix = (entry: string): string | null => {
    if (sortField(entry) !== from) return entry;
    if (to === null) return null;
    const head = entry.trim().startsWith("-") ? "-" : "";
    const tail = /\s+(asc|desc)$/i.exec(entry)?.[0] ?? "";
    return `${head}${to}${tail}`;
  };
  if (Array.isArray(sort)) {
    const next = sort.map(fix).filter((e): e is string => e !== null);
    return next.length ? next : undefined;
  }
  const next = sort
    .split(",")
    .map(fix)
    .filter((e): e is string => e !== null);
  return next.length ? next.join(",") : undefined;
}

/**
 * Views after a field of their table was renamed (`to`) or deleted (`to` null): the field
 * lists, a board's group, and the sort follow. A filter that names the field is dropped,
 * since it would no longer be valid and the whole view would fail to load.
 */
export function viewsAfterField(
  defs: TableViewDef[],
  source: string,
  from: string,
  to: string | null,
): TableViewDef[] {
  const names = (list: string[] | undefined) =>
    list
      ? list.map((n) => (n === from ? to : n)).filter((n): n is string => n !== null)
      : undefined;
  return defs.map((view) => {
    if (view.source !== source) return view;
    const next: TableViewDef = { ...view };
    if (view.columns) next.columns = names(view.columns);
    if (view.show) next.show = names(view.show);
    if (view.group === from) {
      if (to === null) delete next.group;
      else next.group = to;
    }
    const sort = sortAfter(view.sort, from, to);
    if (sort === undefined) delete next.sort;
    else next.sort = sort;
    if (view.filter && mentions(view.filter, from)) delete next.filter;
    return next;
  });
}
