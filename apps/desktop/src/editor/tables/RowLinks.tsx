import { useEffect, useMemo, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  isRelationLinks,
  tables,
  type RelationLink,
  type RowsPage,
  type TableColumn,
  type TableRow,
} from "@/lib/tables";
import { PropertyTag } from "@/pages/PropertySelect";
import { ArrangeItems } from "../views/ArrangeItems";
import { asProperty, CHOICE_TYPES, formatValue } from "./columns";
import { RelationPicker } from "./relations";

/** Above this many links, `auto` shows a list instead of the field's pills (D80). */
export const PILLS_UP_TO = 3;

/** How a link field shows on a row's panel or page: in the fields, or as its own list. */
export function linkMode(column: TableColumn, count: number): "pills" | "list" {
  const as = (column.panel as { as?: string } | null | undefined)?.as ?? "auto";
  if (as === "list" || as === "pills") return as;
  return count > PILLS_UP_TO ? "list" : "pills";
}

/** Show a link field as pills or as a list: stored in the table's schema, for everyone. */
export function setLinkMode(table: string, column: TableColumn, as: "pills" | "list") {
  const panel = (column.panel ?? {}) as Record<string, unknown>;
  return tables.schema(table, { columns: { [column.name]: { panel: { ...panel, as } } } });
}

const COLLAPSED = "graite:row-links-collapsed";
function collapsedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** One field of a listed row, as text (a choice as its pill), with links as their names. */
function Value({ column, value }: { column: TableColumn; value: unknown }) {
  if (value === null || value === undefined || value === "") return null;
  if (CHOICE_TYPES.includes(column.type)) {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    return (
      <>
        {values.map((v) => (
          <PropertyTag key={v} field={asProperty(column)} option={v} />
        ))}
      </>
    );
  }
  return <>{formatValue(column, value)}</>;
}

/**
 * A link field of a row as its own list (D80): the linked rows with the fields chosen for it,
 * collapsible, with "+ Add" to link a row or make a new one. Works for any link field of any
 * table; clicking a row opens it (the panel stacks it, Back returns).
 */
export function RowLinks({
  table,
  rowId,
  rowCell,
  column,
  onOpen,
  onChanged,
}: {
  /** The row's own table and id. */
  table: string;
  rowId: string;
  rowCell: (name: string) => unknown;
  column: TableColumn;
  onOpen: (table: string, id: string) => void;
  /** Something about the row changed (a link, the list's settings): reload it. */
  onChanged: () => void;
}) {
  const value = rowCell(column.name);
  const links = useMemo(() => (isRelationLinks(value) ? value : []), [value]);
  const ids = useMemo(() => links.filter((l) => !l.broken).map((l) => l.id), [links]);
  const [target, setTarget] = useState<{ page: RowsPage; rows: TableRow[] } | null>(null);
  const [adding, setAdding] = useState<RelationLink[] | null>(null);
  const key = `${table}#${column.name}`;
  const [collapsed, setCollapsed] = useState(() => collapsedSet().has(key));
  const idKey = ids.join(",");

  useEffect(() => {
    if (!column.target) return;
    let live = true;
    tables
      .rows(column.target, ids.length ? { ids, limit: Math.min(ids.length, 1000) } : { limit: 0 })
      .then((page) => live && setTarget({ page, rows: page.rows }))
      .catch(() => live && setTarget(null));
    return () => {
      live = false;
    };
    // `idKey` stands for `ids`.
  }, [column.target, idKey]);

  if (!column.target) return null;
  const toggle = () => {
    const set = collapsedSet();
    if (collapsed) set.delete(key);
    else set.add(key);
    try {
      localStorage.setItem(COLLAPSED, JSON.stringify([...set]));
    } catch {
      /* Remembered for this session only. */
    }
    setCollapsed(!collapsed);
  };
  /** Write the row's links: for a reverse field the other table is written (D71). */
  const setLinks = (next: string[]) =>
    tables
      .write(table, [
        {
          op: "update",
          id: rowId,
          values: { [column.name]: next },
          base: { [column.name]: links },
        },
      ])
      .then(onChanged)
      .catch((e: Error) => toast.error(e.message));
  const createNew = async () => {
    try {
      const made = await tables.write(column.target!, [{ op: "insert", values: {} }]);
      const id = made.ids?.[0];
      if (!id) return;
      await setLinks([...ids, id]);
      setAdding(null);
      onOpen(column.target!, id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const page = target?.page;
  const panel = (column.panel ?? {}) as { as?: string; show?: string[] };
  const choices = (page?.columns ?? []).filter(
    (c) => c.name !== page?.primary_key && c.name !== page?.label_column,
  );
  const show =
    panel.show ??
    choices
      .filter((c) => !c.reverse)
      .slice(0, 3)
      .map((c) => c.name);
  const shown = show
    .map((n) => page?.columns.find((c) => c.name === n))
    .filter((c): c is TableColumn => !!c);
  const saveShow = (next: string[]) =>
    void tables
      .schema(table, { columns: { [column.name]: { panel: { ...panel, show: next } } } })
      .then(onChanged)
      .catch((e: Error) => toast.error(e.message));
  const cellOf = (row: TableRow, name?: string | null) =>
    name && page ? row.cells[page.visible.indexOf(name)] : undefined;

  return (
    <section className={`row-links ${collapsed ? "collapsed" : ""}`}>
      <div className="row-links-head">
        <button
          type="button"
          className="row-links-toggle"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          <ChevronRight size={13} className="row-links-chevron" />
          {column.name}
          <span className="row-links-count">{links.length}</span>
        </button>
        <span className="row-links-grow" />
        {!collapsed && page && (
          <>
            <Popover>
              <PopoverTrigger className="row-links-action">Fields</PopoverTrigger>
              <PopoverContent align="end" className="view-menu">
                <small>Shown in this list · drag to reorder</small>
                <ArrangeItems
                  names={[...show, ...choices.map((c) => c.name).filter((n) => !show.includes(n))]}
                  label={(name) => <>{name}</>}
                  shown={(name) => show.includes(name)}
                  onToggle={(name) =>
                    saveShow(show.includes(name) ? show.filter((n) => n !== name) : [...show, name])
                  }
                  onOrder={(order) => saveShow(order.filter((n) => show.includes(n)))}
                />
              </PopoverContent>
            </Popover>
            <button
              type="button"
              className="row-links-action"
              title="Show in the fields above instead"
              onClick={() =>
                void setLinkMode(table, column, "pills")
                  .then(onChanged)
                  .catch((e: Error) => toast.error(e.message))
              }
            >
              Show as field
            </button>
          </>
        )}
        <Popover
          open={adding !== null}
          onOpenChange={(open) => {
            if (open) setAdding(links);
            else {
              if (adding && adding.map((l) => l.id).join() !== links.map((l) => l.id).join())
                void setLinks(adding.map((l) => l.id));
              setAdding(null);
            }
          }}
        >
          <PopoverTrigger className="row-links-action" aria-label={`Add to ${column.name}`}>
            + Add
          </PopoverTrigger>
          <PopoverContent align="end" className="table-tags-editor table-row-picker">
            {adding && (
              <>
                <RelationPicker
                  target={column.target}
                  selected={adding}
                  single={column.cardinality === "one" && !column.reverse}
                  onChange={(next, done) => {
                    if (done) {
                      void setLinks(next.map((l) => l.id));
                      setAdding(null);
                    } else setAdding(next);
                  }}
                />
                <button type="button" className="row-links-new" onClick={() => void createNew()}>
                  New {page?.name ? `row in ${page.name}` : "row"}
                </button>
              </>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {!collapsed &&
        (!target ? (
          <div className="row-links-empty">Loading…</div>
        ) : target.rows.length ? (
          <div className="view-list row-links-list">
            {target.rows.map((row) => {
              const label = cellOf(row, page?.label_column);
              const name =
                label === null || label === undefined || label === "" ? "Untitled" : String(label);
              return (
                <div key={row.id} className="view-list-row row-links-row">
                  <div className="view-list-lead">
                    <button
                      type="button"
                      className="view-page"
                      onClick={() => onOpen(column.target!, row.id)}
                    >
                      <span title={name}>{name}</span>
                    </button>
                  </div>
                  <div className="view-chips">
                    {shown.map((c) => {
                      const v = cellOf(row, c.name);
                      if (
                        v === null ||
                        v === undefined ||
                        v === "" ||
                        (Array.isArray(v) && !v.length)
                      )
                        return null;
                      return (
                        <div key={c.name} className="view-card-property" title={c.name}>
                          <span className="view-chip view-chip-text">
                            <Value column={c} value={v} />
                          </span>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="row-links-remove"
                      aria-label={`Remove ${name} from ${column.name}`}
                      title="Remove from this list"
                      onClick={() => void setLinks(ids.filter((id) => id !== row.id))}
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="row-links-empty">Nothing linked yet.</div>
        ))}
    </section>
  );
}
