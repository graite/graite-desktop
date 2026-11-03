import { request } from "./api";
import { platform } from "./platform";
import type { components } from "@graite/api-types";

/** CSV tables in a page's `_data/` folder, queried through the daemon's SQLite cache (D68). */
export type TableInfo = components["schemas"]["TableModel"];
export type TableColumn = components["schemas"]["ColumnModel"];
export type RowsPage = components["schemas"]["RowsPage"];
export type TableRow = components["schemas"]["RowModel"];
export type RowOp = components["schemas"]["RowOpModel"];
export type ColumnOp = components["schemas"]["ColumnOpModel"];
export type WriteResult = components["schemas"]["WriteResult"];
export type FormulaCheck = components["schemas"]["FormulaCheck"];
export type RowDoc = components["schemas"]["RowDoc"];

/** One linked row in a relation cell (D71), labeled with its current display value. */
export interface RelationLink {
  id: string;
  label: string;
  secondary?: string | null;
  /** The id is not a row of the target table. */
  broken?: boolean;
}

export function isRelationLinks(value: unknown): value is RelationLink[] {
  return (
    Array.isArray(value) &&
    value.every((v) => !!v && typeof v === "object" && typeof (v as RelationLink).id === "string")
  );
}

/** One attachment in a file cell (D76): the stored name in the table page's `_assets/`. */
export interface FileLink {
  file: string;
  name: string;
}

/** One linked page in a page cell (D76), titled live; `broken` when the page is gone. */
export interface PageLink {
  path: string;
  title: string;
  icon?: string | null;
  broken?: boolean;
}

export function isFileLinks(value: unknown): value is FileLink[] {
  return (
    Array.isArray(value) &&
    value.every((v) => !!v && typeof v === "object" && typeof (v as FileLink).file === "string")
  );
}

export function isPageLinks(value: unknown): value is PageLink[] {
  return (
    Array.isArray(value) &&
    value.every((v) => !!v && typeof v === "object" && typeof (v as PageLink).path === "string")
  );
}

export interface RowsQuery {
  filter?: string;
  sort?: string;
  columns?: string[];
  search?: string;
  /** Only these rows (by id). */
  ids?: string[];
  offset?: number;
  limit?: number;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

function query(params: Record<string, string | number | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => q.append(key, v));
    else q.set(key, String(value));
  }
  return q.toString();
}

export const tables = {
  list: (pagePath?: string) =>
    request<TableInfo[]>(`/api/v1/tables?${query({ page_path: pagePath })}`),
  /** The table a block on `pagePath` means by `source` (`_data/x.csv`, a path, or a name). */
  resolve: (pagePath: string, source: string) =>
    request<{ path: string }>(`/api/v1/tables/resolve?${query({ page_path: pagePath, source })}`),
  rows: (path: string, q: RowsQuery = {}, signal?: AbortSignal) =>
    request<RowsPage>(`/api/v1/tables/rows?${query({ path, ...q })}`, { signal }),
  write: (path: string, ops: RowOp[], baseHash?: string) =>
    request<WriteResult>("/api/v1/tables/rows", {
      method: "POST",
      ...json({ path, ops, base_hash: baseHash ?? null }),
    }),
  create: (pagePath: string, name: string, columns: string[]) =>
    request<TableInfo>("/api/v1/tables", {
      method: "POST",
      ...json({ page_path: pagePath, name, columns }),
    }),
  async import(pagePath: string, file: File): Promise<TableInfo> {
    // A raw body, like media uploads: `request` would JSON-encode it.
    const { url, token } = await platform.getDaemonInfo();
    const res = await fetch(
      `${url}/api/v1/tables/import?${query({ page_path: pagePath, name: file.name })}`,
      { method: "POST", body: file, headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new Error(data.detail || `Import failed (${res.status}).`);
    }
    return (await res.json()) as TableInfo;
  },
  /** Give rows without an id one; with `duplicates`, also rows that repeat an earlier id. */
  ensureIds: (path: string, duplicates = false) =>
    request<WriteResult & { reassigned?: Record<string, string[]> }>("/api/v1/tables/ensure-ids", {
      method: "POST",
      ...json({ path, duplicates }),
    }),
  /** Rename the CSV file. Fences and embeds on pages follow, so the open page reloads
   *  (`own: false`, like applying a proposal). */
  rename: (path: string, name: string) =>
    request<TableInfo>("/api/v1/tables/rename", {
      method: "POST",
      own: false,
      ...json({ path, name }),
    }),
  /** Make `column` (new or existing) a relation to `target`, with an optional reverse field. */
  addRelation: (
    path: string,
    column: string,
    target: string,
    cardinality: "one" | "many",
    reverse: string | null,
  ) =>
    request<TableInfo>("/api/v1/tables/relations", {
      method: "POST",
      ...json({ path, column, target, cardinality, reverse }),
    }),
  /** Write this table's current display values into the links other tables hold to it. */
  refreshLabels: (path: string) =>
    request<TableInfo>("/api/v1/tables/link-labels", { method: "POST", ...json({ path }) }),
  columns: (path: string, ops: ColumnOp[], baseHash?: string) =>
    request<WriteResult>("/api/v1/tables/columns", {
      method: "POST",
      ...json({ path, ops, base_hash: baseHash ?? null }),
    }),
  /** How a column's current values would read as `type`, before switching to it. */
  checkType: (path: string, column: string, type: string, target?: string) =>
    request<{ total: number; invalid: number; examples: string[] }>(
      `/api/v1/tables/check-type?${query({ path, column, type, target })}`,
    ),
  /** Rename (`next`) or remove (null) a select option in every row and in the schema. */
  changeOption: (path: string, column: string, old: string, next: string | null) =>
    request<WriteResult>("/api/v1/tables/options", {
      method: "POST",
      ...json({ path, column, old, new: next }),
    }),
  /** Store a file in the table page's attachments for a file column (D76); write the
   *  returned `{file, name}` into the cell afterwards. */
  async uploadFile(path: string, file: File): Promise<FileLink> {
    const { url, token } = await platform.getDaemonInfo();
    const res = await fetch(`${url}/api/v1/tables/files?${query({ path, name: file.name })}`, {
      method: "POST",
      body: file,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new Error(data.detail || `Upload failed (${res.status}).`);
    }
    return (await res.json()) as FileLink;
  },
  /** Open a file column's file in the system's app (desktop) or a new tab (web). */
  async openFile(path: string, item: FileLink): Promise<void> {
    if (platform.openPath) {
      const where = await request<{ path: string }>(
        `/api/v1/tables/files/location?${query({ path, file: item.file })}`,
      );
      return platform.openPath(where.path);
    }
    const { url, token } = await platform.getDaemonInfo();
    const res = await fetch(
      `${url}/api/v1/tables/files/content?${query({ path, file: item.file })}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error("Could not open this file.");
    const objectUrl = URL.createObjectURL(await res.blob());
    window.open(objectUrl, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  },
  /** A row's own document (D80), as Markdown with the hash a save must name. */
  rowDoc: (path: string, id: string) =>
    request<RowDoc>(`/api/v1/tables/row-doc?${query({ path, id })}`),
  /** Save a row's document; `baseHash` "" for a new one. A stale hash is a 409 (ApiError). */
  writeRowDoc: (path: string, id: string, body: string, baseHash: string, title: string) =>
    request<RowDoc>("/api/v1/tables/row-doc", {
      method: "PUT",
      ...json({ path, id, body, base_hash: baseHash, title }),
    }),
  /** Whether a formula works on this table, with its values for the first rows (D75). */
  checkFormula: (path: string, formula: string, column?: string | null) =>
    request<FormulaCheck>("/api/v1/tables/formula/check", {
      method: "POST",
      ...json({ path, formula, column: column ?? null }),
    }),
  /** Merge into the schema file: `columns.<name>` merges key by key; null removes a key. */
  schema: (path: string, schema: Record<string, unknown>) =>
    request<TableInfo>("/api/v1/tables/schema", { method: "PATCH", ...json({ path, schema }) }),
  /** Add a Status field (Todo / Doing / Done) so a board has columns to group by (D82). */
  async addStatusField(table: Pick<TableInfo, "path" | "columns">): Promise<string> {
    const taken = new Set((table.columns ?? []).map((c) => c.name.toLowerCase()));
    let name = "status";
    for (let n = 2; taken.has(name); n++) name = `status ${n}`;
    await tables.columns(table.path, [{ op: "add", name }]);
    await tables.schema(table.path, {
      columns: {
        [name]: {
          type: "status",
          options: ["Todo", "Doing", "Done"],
          colors: { Todo: "gray", Doing: "blue", Done: "green" },
        },
      },
    });
    return name;
  },
};

/** How a block on `pagePath` refers to a table: short for its own `_data/`, else the path. */
export function sourceFor(
  pagePath: string,
  table: Pick<TableInfo, "path" | "page_path" | "name">,
): string {
  return table.page_path === pagePath ? `_data/${table.name}.csv` : table.path;
}

/** Warnings from the cache in words the user can act on. */
export function describeWarning(warning: string): string {
  // `kind:detail`; the detail is a count or a column name (which may hold colons).
  const at = warning.indexOf(":");
  const kind = at < 0 ? warning : warning.slice(0, at);
  const count = at < 0 ? "" : warning.slice(at + 1);
  switch (kind) {
    case "ids_missing":
      return "This table has no id column yet. Graite adds one on the first edit.";
    case "ids_blank":
      return `${count} row(s) have no id. They get one on the next edit.`;
    case "ids_duplicate":
      return `${count} row(s) repeat an earlier id. Links to that id mean the first row.`;
    case "rows_long":
      return `${count} row(s) have more cells than the header; the extra cells are not shown.`;
    case "links_broken":
      return `${count} link(s) point to rows that no longer exist. They show in red.`;
    case "relation_target_missing":
      return `The table that “${count}” links to cannot be found.`;
    case "formula_invalid": {
      // `formula_invalid:<column>:<message>`
      const colon = count.indexOf(":");
      const column = colon < 0 ? count : count.slice(0, colon);
      const message = colon < 0 ? "" : count.slice(colon + 1);
      return `The formula of “${column}” has a problem: ${message} Its cells stay empty.`;
    }
    case "table_id_duplicate":
      return "Another table has the same id (a copied folder?). Links may pick either table.";
    default:
      return warning;
  }
}

/** Tables in groups, nearest first: this page, the rest of its top-level page, everything else. */
export interface TableGroup {
  key: "here" | "near" | "other";
  label: string;
  tables: TableInfo[];
}

/** How far apart two pages are in the tree: steps up to the shared parent, then down. */
function treeDistance(a: string, b: string): number {
  const x = a ? a.split("/") : [];
  const y = b ? b.split("/") : [];
  let shared = 0;
  while (shared < x.length && shared < y.length && x[shared] === y[shared]) shared++;
  return x.length - shared + (y.length - shared);
}

/**
 * The tables a page would want first (D82): its own, then those under the same top-level page
 * (closest pages first, e.g. the CRM's tables when inside the CRM), then all others.
 */
export function rankTables(list: TableInfo[], pagePath: string): TableGroup[] {
  const top = pagePath.split("/")[0] ?? "";
  const byName = (a: TableInfo, b: TableInfo) => a.name.localeCompare(b.name);
  const here = list.filter((t) => t.page_path === pagePath).sort(byName);
  const near = list
    .filter(
      (t) =>
        t.page_path !== pagePath &&
        top &&
        (t.page_path === top || t.page_path.startsWith(`${top}/`)),
    )
    .sort(
      (a, b) =>
        treeDistance(pagePath, a.page_path) - treeDistance(pagePath, b.page_path) ||
        a.page_path.localeCompare(b.page_path) ||
        byName(a, b),
    );
  const other = list
    .filter((t) => !here.includes(t) && !near.includes(t))
    .sort((a, b) => a.page_path.localeCompare(b.page_path) || byName(a, b));
  const groups: TableGroup[] = [
    { key: "here", label: "On this page", tables: here },
    { key: "near", label: `In ${top.split("/").pop() || "this workspace"}`, tables: near },
    { key: "other", label: "Other pages", tables: other },
  ];
  return groups.filter((g) => g.tables.length);
}
