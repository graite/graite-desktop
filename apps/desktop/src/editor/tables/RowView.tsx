import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, FileText, Link2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PageDoc } from "@/lib/api";
import {
  isFileLinks,
  isPageLinks,
  isRelationLinks,
  tables,
  type PageLink,
  type RelationLink,
  type RowsPage,
  type TableColumn,
} from "@/lib/tables";
import { PropertyValue } from "@/pages/PageProperties";
import { asProperty, formatValue, TypeIcon } from "./columns";
import { RelationPicker } from "./relations";
import { FileList, PageLinkPicker } from "./linkcells";
import { linkMode, RowLinks, setLinkMode } from "./RowLinks";
import { RowDocument } from "./RowDocument";

export interface OpenRow {
  /** The table's vault path. */
  table: string;
  id: string;
}

// Table fields are never media or created/updated, the only kinds PropertyValue reads the
// page for.
const NO_PAGE = { id: "", path: "", frontmatter: {} } as unknown as PageDoc;

/** Text on as many lines as it needs (notes stay readable), saved when the field loses
 *  focus. Enter adds a line; Ctrl/Cmd+Enter or Escape is done. */
function TextField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  return (
    <textarea
      ref={box}
      className="table-row-text"
      aria-label={name}
      rows={1}
      value={draft}
      placeholder="Empty"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onChange(draft === "" ? null : draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** A checkbox drawn like the grid's: a rounded square, filled with a check when on. */
function CheckField({
  name,
  checked,
  onChange,
}: {
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={name}
      className="table-row-check"
      onClick={() => onChange(!checked)}
    >
      {checked && <Check size={12} strokeWidth={3} />}
    </button>
  );
}

function RelationField({
  column,
  links,
  onOpen,
  onChange,
}: {
  column: TableColumn;
  links: RelationLink[];
  onOpen: (link: RelationLink) => void;
  onChange: (links: RelationLink[]) => void;
}) {
  const [draft, setDraft] = useState<RelationLink[] | null>(null);
  return (
    <div className="table-row-links">
      {links.map((link) => (
        <button
          key={link.id}
          type="button"
          className={`table-relation-pill link${link.broken ? " broken" : ""}`}
          disabled={link.broken}
          title={link.broken ? "This row no longer exists" : `Open ${link.label || "row"}`}
          onClick={() => onOpen(link)}
        >
          <Link2 size={12} />
          {link.broken ? link.label || "Missing row" : link.label || "Untitled"}
        </button>
      ))}
      {column.target && (
        <Popover
          open={draft !== null}
          onOpenChange={(open) => {
            if (open) setDraft(links);
            else {
              if (draft && draft.map((l) => l.id).join() !== links.map((l) => l.id).join())
                onChange(draft);
              setDraft(null);
            }
          }}
        >
          <PopoverTrigger
            className="table-row-link-edit"
            aria-label={`${links.length ? "Edit" : "Add"} ${column.name}`}
          >
            {links.length ? <Pencil size={11} strokeWidth={2.25} /> : <Plus size={12} />}
            {links.length ? "Edit" : "Add link"}
          </PopoverTrigger>
          <PopoverContent align="start" className="table-tags-editor table-row-picker">
            {draft && (
              <RelationPicker
                target={column.target}
                selected={draft}
                single={column.cardinality === "one" && !column.reverse}
                onChange={(next, done) => {
                  if (done) {
                    onChange(next);
                    setDraft(null);
                  } else setDraft(next);
                }}
              />
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function PageField({
  column,
  links,
  onOpen,
  onChange,
}: {
  column: TableColumn;
  links: PageLink[];
  onOpen: (path: string) => void;
  onChange: (links: PageLink[]) => void;
}) {
  const [draft, setDraft] = useState<PageLink[] | null>(null);
  return (
    <div className="table-row-links">
      {links.map((link) => (
        <button
          key={link.path}
          type="button"
          className={`table-relation-pill link page${link.broken ? " broken" : ""}`}
          disabled={link.broken}
          title={link.broken ? "This page no longer exists" : `Open ${link.title || "page"}`}
          onClick={() => onOpen(link.path)}
        >
          <FileText size={12} />
          {link.title || "Untitled"}
        </button>
      ))}
      <Popover
        open={draft !== null}
        onOpenChange={(open) => {
          if (open) setDraft(links);
          else {
            if (draft && draft.map((l) => l.path).join() !== links.map((l) => l.path).join())
              onChange(draft);
            setDraft(null);
          }
        }}
      >
        <PopoverTrigger
          className="table-row-link-edit"
          aria-label={`${links.length ? "Edit" : "Add"} ${column.name}`}
        >
          {links.length ? <Pencil size={11} strokeWidth={2.25} /> : <Plus size={12} />}
          {links.length ? "Edit" : "Link a page"}
        </PopoverTrigger>
        <PopoverContent align="start" className="table-tags-editor table-row-picker">
          {draft && (
            <PageLinkPicker
              selected={draft}
              single={column.cardinality === "one"}
              onChange={(next, done) => {
                if (done) {
                  onChange(next);
                  setDraft(null);
                } else setDraft(next);
              }}
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** One row loaded by id, with a save for one field; `version` reloads it. */
export function useRow(row: OpenRow | null) {
  const [page, setPage] = useState<RowsPage | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!row) return;
    tables
      .rows(row.table, { ids: [row.id], limit: 1 })
      .then((p) => {
        setPage(p);
        setError(p.rows.length ? "" : "This row no longer exists.");
      })
      .catch((e: Error) => setError(e.message));
  }, [row]);
  useEffect(() => {
    setPage(null);
    setError("");
    load();
  }, [load]);
  const record = page?.rows[0];
  const cell = useCallback(
    (name: string) => (record && page ? record.cells[page.visible.indexOf(name)] : undefined),
    [record, page],
  );
  const text = (value: unknown) =>
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(", ")
        : String(value);
  const label = page?.label_column ? text(cell(page.label_column)) : "";
  const secondary = page?.secondary_column ? text(cell(page.secondary_column)) : "";
  return { page, record, cell, error, load, label, secondary };
}

/**
 * Everything about one row (D80): its fields (editable), its link fields (in the fields as
 * pills, or each as its own collapsible list), and its own document. Shared by the side
 * panel and the full page.
 */
export function RowView({
  row,
  layout,
  heading,
  onOpen,
  onOpenPage,
  onDeleted,
}: {
  row: OpenRow;
  layout: "panel" | "page";
  /** The title area, given the row's name and detail, and the row's actions (Delete). */
  heading: (
    label: string,
    secondary: string,
    page: RowsPage | null,
    actions: ReactNode,
  ) => ReactNode;
  /** The row was deleted: close it or go back. */
  onDeleted?: () => void;
  /** Open a linked row (the panel stacks it; Back returns). */
  onOpen: (table: string, id: string) => void;
  onOpenPage?: (path: string) => void;
}) {
  const { page, record, cell, error, load, label, secondary } = useRow(row);
  const save = async (column: TableColumn, value: unknown) => {
    if (!record) return;
    try {
      await tables.write(row.table, [
        {
          op: "update",
          id: row.id,
          values: { [column.name]: value },
          base: { [column.name]: cell(column.name) ?? null },
        },
      ]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    load();
  };
  // Link fields shown as lists, in field order.
  const lists = (page?.columns ?? []).filter((c) => {
    if (c.type !== "relation" || !c.target) return false;
    const value = cell(c.name);
    return linkMode(c, isRelationLinks(value) ? value.length : 0) === "list";
  });
  const sections = new Set(lists.map((c) => c.name));
  const linked = page && record && (
    <div className="row-sections">
      {lists.map((column) => (
        <RowLinks
          key={column.name}
          table={row.table}
          rowId={row.id}
          rowCell={cell}
          column={column}
          onOpen={onOpen}
          onChanged={load}
        />
      ))}
    </div>
  );
  const document = page && record && (
    <section className="row-document">
      <h3 className="row-links-head">Notes</h3>
      <RowDocument table={row.table} id={row.id} title={label} onNavigate={onOpenPage} />
    </section>
  );
  return (
    <div className={`row-view row-view-${layout}`}>
      {heading(
        label,
        secondary,
        page,
        record ? (
          <DeleteRow
            table={row.table}
            id={row.id}
            name={label || "this row"}
            onDeleted={() => onDeleted?.()}
          />
        ) : null,
      )}
      {error && <div className="table-empty error">{error}</div>}
      {page && record && (
        <div className="table-row-fields">
          {page.columns
            .filter((c) => c.name !== page.primary_key && !sections.has(c.name))
            .map((column) => {
              const value = cell(column.name);
              return (
                <div key={column.name} className="table-row-field">
                  <span className="table-row-field-name">
                    <TypeIcon type={column.type} size={14} />
                    {column.name}
                    {column.type === "relation" && column.target && (
                      <button
                        type="button"
                        className="table-row-as-list"
                        title={`Show ${column.name} as a list below`}
                        onClick={() =>
                          void setLinkMode(row.table, column, "list")
                            .then(load)
                            .catch((e: Error) => toast.error(e.message))
                        }
                      >
                        Show as list
                      </button>
                    )}
                  </span>
                  <div className="table-row-field-value">
                    {column.type === "file" ? (
                      <FileList
                        table={row.table}
                        files={isFileLinks(value) ? value : []}
                        single={column.cardinality === "one"}
                        onChange={(files) => void save(column, files)}
                        onOpen={(f) =>
                          void tables
                            .openFile(row.table, f)
                            .catch((e: Error) => toast.error(e.message))
                        }
                      />
                    ) : column.type === "page" ? (
                      <PageField
                        column={column}
                        links={isPageLinks(value) ? value : []}
                        onOpen={(target) => onOpenPage?.(target)}
                        onChange={(links) =>
                          void save(
                            column,
                            links.map((l) => ({ path: l.path, title: l.title })),
                          )
                        }
                      />
                    ) : column.type === "formula" ? (
                      <span className="table-row-computed" title={column.formula ?? ""}>
                        {formatValue(column, value) || "—"}
                      </span>
                    ) : column.type === "relation" ? (
                      <RelationField
                        column={column}
                        links={isRelationLinks(value) ? value : []}
                        onOpen={(link) => column.target && onOpen(column.target, link.id)}
                        onChange={(links) =>
                          void save(
                            column,
                            links.map((l) => l.id),
                          )
                        }
                      />
                    ) : column.type === "text" ? (
                      <TextField
                        name={column.name}
                        value={value === null || value === undefined ? "" : String(value)}
                        onChange={(next) => void save(column, next)}
                      />
                    ) : column.type === "checkbox" ? (
                      <CheckField
                        name={column.name}
                        checked={value === true}
                        onChange={(next) => void save(column, next)}
                      />
                    ) : (
                      <PropertyValue
                        page={NO_PAGE}
                        field={asProperty(
                          column,
                          (value ?? null) as Parameters<typeof asProperty>[1],
                        )}
                        onChange={(next) => void save(column, next)}
                        onFieldChange={(field) =>
                          true &&
                          void tables
                            .schema(row.table, {
                              columns: {
                                [column.name]: { options: field.options, colors: field.colors },
                              },
                            })
                            .then(load)
                            .catch((e: Error) => toast.error(e.message))
                        }
                      />
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      )}
      {linked}
      {document}
    </div>
  );
}

/** Delete the open row: a second click confirms, nothing else asks. */
export function DeleteRow({
  table,
  id,
  name,
  onDeleted,
}: {
  table: string;
  id: string;
  name: string;
  onDeleted: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`view-button row-delete ${armed ? "armed" : ""}`}
      title={`Delete ${name}`}
      onClick={() => {
        if (!armed) return setArmed(true);
        void tables
          .write(table, [{ op: "delete", id, values: {} }])
          .then(() => {
            toast.success(`Deleted ${name}.`);
            onDeleted();
          })
          .catch((e: Error) => toast.error(e.message));
      }}
    >
      {armed ? "Click again to delete" : "Delete"}
    </button>
  );
}
