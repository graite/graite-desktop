import { useEffect, useMemo } from "react";
import { FileText, Link2, Paperclip } from "lucide-react";
import type { PageProperty } from "@/lib/workspace";
import {
  isFileLinks,
  isPageLinks,
  isRelationLinks,
  type RowOp,
  type TableColumn,
  type TableRow,
} from "@/lib/tables";
import { PropertyTag } from "@/pages/PropertySelect";
import type { BoardItem, BoardSource } from "../views/board";
import { asProperty, CHOICE_TYPES, formatValue, shortName, shownAs } from "./columns";
import type { TableMeta } from "./useTableRows";

/** Boards and lists show at most this many rows (they have no paging). */
export const BOARD_ROWS = 1000;

export interface BoardRow extends BoardItem {
  cells: Record<string, unknown>;
}

/** Columns a board can group by: status and single select. */
export function groupColumns(meta: TableMeta | null): TableColumn[] {
  return (meta?.columns ?? []).filter((c) => c.type === "status" || c.type === "single_select");
}

/** What a card shows when the view does not say: up to four fields besides its name. */
export function defaultShown(meta: TableMeta, group?: string): string[] {
  return meta.columns
    .filter(
      (c) =>
        c.name !== meta.primary_key &&
        c.name !== meta.label_column &&
        c.name !== group &&
        !c.reverse,
    )
    .slice(0, 4)
    .map((c) => c.name);
}

function empty(value: unknown): boolean {
  return (
    value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)
  );
}

/** One field of a card, drawn like the grid draws it: pills for choices and links. */
export function TableChip({ column, value }: { column: TableColumn; value: unknown }) {
  if (empty(value)) return null;
  const field = asProperty(column);
  if (CHOICE_TYPES.includes(column.type)) {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    return (
      <span className="view-chip-tags">
        {values.map((v) => (
          <PropertyTag key={v} field={field} option={v} />
        ))}
      </span>
    );
  }
  if (isRelationLinks(value) && column.type === "relation")
    return (
      <span className="view-chip view-chip-link" title={column.name}>
        <Link2 size={11} /> {value.map((l) => l.label || "Untitled").join(", ")}
      </span>
    );
  if (isPageLinks(value))
    return (
      <span className="view-chip view-chip-link" title={column.name}>
        <FileText size={11} /> {value.map((p) => p.title || "Untitled").join(", ")}
      </span>
    );
  if (isFileLinks(value))
    return (
      <span className="view-chip view-chip-link" title={column.name}>
        <Paperclip size={11} /> {value.map((f) => shortName(f.name, 22)).join(", ")}
      </span>
    );
  const shown = shownAs(column);
  if (shown.type === "checkbox")
    return value === true ? (
      <span className="view-chip view-chip-text">✓ {column.name}</span>
    ) : null;
  return (
    <span className="view-chip view-chip-text" title={column.name}>
      {formatValue(column, value)}
    </span>
  );
}

/**
 * Table rows as a board or list (D79): the board arranges them, this says how. Order comes
 * from the view's sort (the CSV is never reshuffled), so a drop only changes the group value.
 */
export function useTableBoard({
  meta,
  row,
  ensure,
  group,
  show,
  write,
}: {
  meta: TableMeta | null;
  row: (index: number) => TableRow | undefined;
  ensure: (first: number, last: number) => void;
  group?: string;
  show: string[];
  write: (ops: RowOp[], optimistic?: [string, number, unknown][]) => Promise<void>;
}): { source: BoardSource<BoardRow> | null; groupField: PageProperty | null; more: number } {
  const total = meta?.total ?? 0;
  const count = Math.min(total, BOARD_ROWS);
  useEffect(() => {
    if (count) ensure(0, count - 1);
  }, [count, ensure]);

  const rows = useMemo(() => {
    if (!meta) return [];
    const out: BoardRow[] = [];
    for (let i = 0; i < count; i++) {
      const r = row(i);
      if (!r) continue;
      const cells = Object.fromEntries(meta.visible.map((name, n) => [name, r.cells[n]]));
      const label = meta.label_column ? cells[meta.label_column] : null;
      out.push({
        id: r.id,
        title: label === null || label === undefined ? "" : String(label),
        cells,
      });
    }
    return out;
  }, [meta, row, count]);

  const groupColumn = meta?.columns.find((c) => c.name === group && groupColumns(meta).includes(c));
  const groupField = groupColumn ? asProperty(groupColumn) : null;
  const columns = useMemo(
    () =>
      meta
        ? show
            .map((n) => meta.columns.find((c) => c.name === n))
            .filter((c): c is TableColumn => !!c)
        : [],
    [meta, show],
  );

  if (!meta) return { source: null, groupField, more: 0 };
  const at = (name: string) => meta.visible.indexOf(name);
  const groupOf = (r: BoardRow) => {
    const value = groupColumn ? r.cells[groupColumn.name] : null;
    return value === null || value === undefined ? "" : String(value);
  };
  const label = meta.label_column;
  const source: BoardSource<BoardRow> = {
    rows,
    group: groupOf,
    move: async (r, column) => {
      if (!groupColumn || groupOf(r) === column) return;
      const value = column || null;
      await write(
        [
          {
            op: "update",
            id: r.id,
            values: { [groupColumn.name]: value },
            base: { [groupColumn.name]: r.cells[groupColumn.name] ?? null },
          },
        ],
        [[r.id, at(groupColumn.name), value]],
      );
    },
    create: (title, column) =>
      write([
        {
          op: "insert",
          values: {
            ...(label ? { [label]: title } : {}),
            ...(groupColumn && column ? { [groupColumn.name]: column } : {}),
          },
        },
      ]),
    remove: (r) => write([{ op: "delete", id: r.id, values: {} }]),
    icon: () => null,
    chips: (r) => {
      const chips = columns.map((c) => [c, r.cells[c.name]] as const).filter(([, v]) => !empty(v));
      return chips.length ? (
        <div className="view-chips">
          {chips.map(([c, v]) => (
            <div className="view-card-property" key={c.name}>
              <TableChip column={c} value={v} />
            </div>
          ))}
        </div>
      ) : null;
    },
    placeholder: label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : "Name",
  };
  return { source, groupField, more: Math.max(0, total - BOARD_ROWS) };
}
