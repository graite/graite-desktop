import { useState } from "react";
import { Table2 } from "lucide-react";
import type { Proposal } from "@/lib/review";
import type { TableColumn } from "@/lib/tables";
import { PropertyTag } from "@/pages/PropertySelect";
import { asProperty, CHOICE_TYPES, formatValue } from "@/editor/tables/columns";

type RowsChange = NonNullable<Proposal["rows"]>;
type RowChange = RowsChange["ops"][number];
type ColumnMeta = NonNullable<RowsChange["columns"]>[string];

const OP = {
  insert: { glyph: "+", word: "New" },
  update: { glyph: "✎", word: "Edited" },
  delete: { glyph: "−", word: "Deleted" },
} as const;

/** A value is long when it would wrap on its own: it goes on its own clamped line. */
const LONG = 40;
const CLAMP_TOGGLE = 120;

/** The table's name and page from its path: `Projects/Atlas/_data/expenses.csv`. */
export function tableName(path: string): { name: string; page: string } {
  const [page = "", file = path] = path.split("/_data/");
  return { name: file.replace(/\.csv$/i, ""), page: page.split("/").pop() ?? page };
}

function column(name: string, meta: ColumnMeta | undefined): TableColumn {
  return {
    name,
    type: meta?.type ?? "text",
    options: meta?.options ?? [],
    colors: meta?.colors ?? {},
    currency: meta?.currency ?? null,
    invalid: 0,
    wrap: false,
  };
}

const isEmpty = (value: unknown) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);

function text(col: TableColumn, value: unknown): string {
  if (col.type === "checkbox") return value ? "✓" : "—";
  return formatValue(col, value);
}

const isLong = (col: TableColumn, value: unknown) =>
  !isEmpty(value) &&
  !CHOICE_TYPES.includes(col.type) &&
  (text(col, value).length > LONG || text(col, value).includes("\n"));

/** One value, drawn the way the table draws it: pills for choices, money as money. */
function Value({ col, value }: { col: TableColumn; value: unknown }) {
  if (isEmpty(value)) return <em className="rows-change-empty">empty</em>;
  if (CHOICE_TYPES.includes(col.type)) {
    const field = asProperty(col);
    const items = Array.isArray(value) ? value.map(String) : [String(value)];
    return (
      <span className="rows-change-pills">
        {items.map((o) => (
          <PropertyTag key={o} field={field} option={o} />
        ))}
      </span>
    );
  }
  return <>{text(col, value)}</>;
}

/** Long text, clamped to a few lines, with its own "More". */
function Clamp({
  col,
  value,
  lines,
  was,
}: {
  col: TableColumn;
  value: unknown;
  lines: number;
  was?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const long = !isEmpty(value) && text(col, value).length > CLAMP_TOGGLE;
  return (
    <span className="rows-change-clamp" data-was={was || undefined}>
      <span
        className="rows-change-clamp-text"
        style={open ? undefined : { WebkitLineClamp: lines, lineClamp: lines }}
        data-open={open || undefined}
      >
        <Value col={col} value={value} />
      </span>
      {long && (
        <button type="button" className="rows-change-link" onClick={() => setOpen((o) => !o)}>
          {open ? "Less" : "More"}
        </button>
      )}
    </span>
  );
}

function Field({ col, before, after }: { col: TableColumn; before?: unknown; after: unknown }) {
  const edited = before !== undefined;
  const stacked = isLong(col, after) || (edited && isLong(col, before));
  return (
    <div className="rows-change-field">
      <dt>{col.name}</dt>
      {stacked ? (
        <dd className="rows-change-stacked">
          {edited && <Clamp col={col} value={before} lines={2} was />}
          <Clamp col={col} value={after} lines={3} />
        </dd>
      ) : (
        <dd>
          {edited && (
            <>
              <span className="rows-change-was">
                <Value col={col} value={before} />
              </span>
              <span className="rows-change-arrow" aria-hidden>
                →
              </span>
            </>
          )}
          <Value col={col} value={after} />
        </dd>
      )}
    </div>
  );
}

function Change({ op, columns }: { op: RowChange; columns: RowsChange["columns"] }) {
  const kind = OP[op.op as keyof typeof OP] ?? OP.update;
  const values = op.values ?? {};
  const fields =
    op.op === "insert"
      ? Object.entries(values).filter(([, v]) => !isEmpty(v))
      : op.op === "update"
        ? Object.entries(values)
        : [];
  return (
    <li className="rows-change" data-op={op.op}>
      <div className="rows-change-title">
        <span className="rows-change-glyph" aria-hidden>
          {kind.glyph}
        </span>
        <span className="rows-change-label">
          {op.label || (op.id ? `Row ${op.id}` : "New row")}
        </span>
        <span className="rows-change-op">{kind.word}</span>
      </div>
      {fields.length > 0 && (
        <dl className="rows-change-fields">
          {fields.map(([name, value]) => (
            <Field
              key={name}
              col={column(name, columns?.[name])}
              before={op.op === "update" ? (op.base?.[name] ?? null) : undefined}
              after={value}
            />
          ))}
        </dl>
      )}
    </li>
  );
}

/**
 * What a `rows` proposal does to a table, as a short list: each changed row by name, the
 * fields that change with their old and new values, new rows with what they hold, and deleted
 * rows by name only. Long values are clamped; long lists show the first few.
 */
export function RowsDiff({
  rows,
  limit = 4,
  showTable = false,
}: {
  rows: RowsChange;
  limit?: number;
  /** Name the table in the header (where the card does not already). */
  showTable?: boolean;
}) {
  const [all, setAll] = useState(false);
  const counts = (["insert", "update", "delete"] as const)
    .map((op) => [op, rows.ops.filter((o) => o.op === op).length] as const)
    .filter(([, n]) => n > 0)
    .map(([op, n]) => `${n} ${OP[op].word.toLowerCase()}`);
  const shown = all ? rows.ops : rows.ops.slice(0, limit);
  const { name, page } = tableName(rows.table);
  return (
    <section className="rows-changes" aria-label={`Changes to ${name}`}>
      <header>
        {showTable && (
          <span className="rows-change-table">
            <Table2 className="size-3.5" />
            {name}
            {page && <span className="rows-change-page"> · {page}</span>}
          </span>
        )}
        <span className="rows-change-counts">{counts.join(" · ")}</span>
      </header>
      <ul>
        {shown.map((op, i) => (
          <Change key={`${op.op}-${op.id ?? ""}-${i}`} op={op} columns={rows.columns} />
        ))}
      </ul>
      {rows.ops.length > limit && (
        <button
          type="button"
          className="rows-change-link rows-change-all"
          onClick={() => setAll((a) => !a)}
        >
          {all ? "Show fewer" : `Show all ${rows.ops.length} changes`}
        </button>
      )}
    </section>
  );
}
