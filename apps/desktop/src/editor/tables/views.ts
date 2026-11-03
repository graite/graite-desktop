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
