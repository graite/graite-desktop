import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Link2, Pencil, Plus, Table2, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PageDoc } from "@/lib/api";
import {
  isRelationLinks,
  tables,
  type RelationLink,
  type RowsPage,
  type TableColumn,
} from "@/lib/tables";
import { PropertyValue } from "@/pages/PageProperties";
import { asProperty, TypeIcon } from "./columns";
import { RelationPicker } from "./relations";

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

/**
 * One row of a table as a panel: every field, editable, with linked rows as pills that
 * open in the same panel (Back returns). Opened from a relation pill in the grid (D71).
 */
export function RowPanel({
  row,
  onClose,
  onOpenTable,
}: {
  row: OpenRow | null;
  onClose: () => void;
  /** Show this table in the block; offered when the table is one of the block's tabs. */
  onOpenTable?: (table: string) => boolean;
}) {
  const [stack, setStack] = useState<OpenRow[]>([]);
  const [page, setPage] = useState<RowsPage | null>(null);
  const [error, setError] = useState("");
  const current = stack[stack.length - 1] ?? null;

  useEffect(() => setStack(row ? [row] : []), [row]);

  const load = useCallback(() => {
    if (!current) return;
    tables
      .rows(current.table, { ids: [current.id], limit: 1 })
      .then((p) => {
        setPage(p);
        setError(p.rows.length ? "" : "This row no longer exists.");
      })
      .catch((e: Error) => setError(e.message));
  }, [current]);
  useEffect(() => {
    setPage(null);
    setError("");
    load();
  }, [load]);

  const record = page?.rows[0];
  const cell = (name: string) => record?.cells[page!.visible.indexOf(name)];
  const label = page?.label_column ? cell(page.label_column) : null;
  const secondary = page?.secondary_column ? cell(page.secondary_column) : null;

  const save = async (column: TableColumn, value: unknown) => {
    if (!current || !record) return;
    try {
      await tables.write(current.table, [
        {
          op: "update",
          id: current.id,
          values: { [column.name]: value },
          base: { [column.name]: cell(column.name) ?? null },
        },
      ]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    load();
  };

  return (
    <Dialog open={!!row} onOpenChange={(open) => !open && onClose()}>
      {/* A plain sheet on the radix primitives: no centered layout or zoom animation to
          undo, so it looks the same in every webview (WebKitGTK included). */}
      <DialogPortal>
        <DialogPrimitive.Overlay className="table-row-overlay" />
        <DialogPrimitive.Content className="table-row-panel">
          <div className="table-row-panel-head">
            {stack.length > 1 && (
              <button
                type="button"
                className="view-button"
                aria-label="Back"
                onClick={() => setStack((s) => s.slice(0, -1))}
              >
                <ArrowLeft size={13} />
              </button>
            )}
            <span className="table-row-panel-table">
              <Table2 size={13} />
              {page?.name ?? ""}
            </span>
            {current && onOpenTable && page && (
              <button
                type="button"
                className="view-button"
                onClick={() => {
                  if (onOpenTable(current.table)) onClose();
                }}
              >
                Open table
              </button>
            )}
            <DialogPrimitive.Close className="table-row-close" aria-label="Close">
              <X size={15} />
            </DialogPrimitive.Close>
          </div>
          <DialogTitle className="table-row-panel-title">
            {label === null || label === undefined || label === ""
              ? "Untitled"
              : String(Array.isArray(label) ? label.join(", ") : label)}
          </DialogTitle>
          <DialogDescription className="table-row-panel-secondary">
            {secondary === null || secondary === undefined
              ? ""
              : Array.isArray(secondary)
                ? secondary.join(", ")
                : String(secondary)}
          </DialogDescription>
          {error && <div className="table-empty error">{error}</div>}
          {page && record && (
            <div className="table-row-fields">
              {page.columns
                .filter((c) => c.name !== page.primary_key)
                .map((column) => {
                  const value = cell(column.name);
                  return (
                    <div key={column.name} className="table-row-field">
                      <span className="table-row-field-name">
                        <TypeIcon type={column.type} size={14} />
                        {column.name}
                      </span>
                      <div className="table-row-field-value">
                        {column.type === "relation" ? (
                          <RelationField
                            column={column}
                            links={isRelationLinks(value) ? value : []}
                            onOpen={(link) =>
                              column.target &&
                              setStack((s) => [...s, { table: column.target!, id: link.id }])
                            }
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
                              current &&
                              void tables
                                .schema(current.table, {
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
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
