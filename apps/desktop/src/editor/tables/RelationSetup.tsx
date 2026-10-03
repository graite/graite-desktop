import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronRight, FolderOpen, Search, Table2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { tables, type TableInfo } from "@/lib/tables";
import { byFolder } from "./TableTabs";

export interface RelationChoice {
  target: string;
  cardinality: "one" | "many";
  /** Name of the reverse field on the target, or null for none. */
  reverse: string | null;
}

/**
 * Where a relation field links to (D71), in two steps: pick the table (from any folder),
 * then say whether a row may link to several rows and whether the other table shows the
 * links back as a field of its own.
 */
export function RelationSetup({
  table,
  submit,
  onSubmit,
  onCancel,
}: {
  /** The table that gets the relation field. */
  table: { path: string; name: string };
  submit: string;
  onSubmit: (choice: RelationChoice) => void;
  onCancel: () => void;
}) {
  const [all, setAll] = useState<TableInfo[] | null>(null);
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<TableInfo | null>(null);
  const [many, setMany] = useState(true);
  const [back, setBack] = useState(true);
  const [reverse, setReverse] = useState(table.name);

  useEffect(() => {
    tables
      .list()
      .then(setAll)
      .catch(() => setAll([]));
  }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return byFolder(
      (all ?? []).filter(
        (t) => !q || t.name.toLowerCase().includes(q) || t.page_path.toLowerCase().includes(q),
      ),
    );
  }, [all, search]);

  if (!target)
    return (
      <div className="relation-setup">
        <div className="relation-setup-title">Link to a table</div>
        <label className="relation-setup-search">
          <Search size={13} />
          <input
            autoFocus
            placeholder="Search tables"
            aria-label="Search tables"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="relation-setup-list" role="listbox" aria-label="Table to link to">
          {all === null && <div className="relation-setup-empty">Loading…</div>}
          {all !== null && !shown.length && (
            <div className="relation-setup-empty">No tables match.</div>
          )}
          {shown.map(([page, items]) => (
            <div key={page} className="relation-setup-folder">
              <div className="relation-setup-folder-name">
                <FolderOpen size={12} />
                {page}
              </div>
              {items.map((t) => (
                <button
                  key={t.path}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="relation-setup-table"
                  onClick={() => {
                    setTarget(t);
                    // Named after this table unless the user already typed a name.
                    setReverse((r) => r.trim() || table.name);
                  }}
                >
                  <Table2 size={14} />
                  <span className="relation-setup-table-name">{t.name}</span>
                  {t.path === table.path && <span className="relation-setup-tag">this table</span>}
                  <span className="relation-setup-count">{t.row_count}</span>
                  <ChevronRight size={13} className="relation-setup-chevron" />
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="relation-setup-actions">
          <button type="button" className="table-button ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );

  const name = reverse.trim();
  const taken =
    back && !!name && target.columns.some((c) => c.name.toLowerCase() === name.toLowerCase());
  const self = target.path === table.path;

  return (
    <div className="relation-setup">
      <div className="relation-setup-head">
        <button
          type="button"
          className="relation-setup-back"
          aria-label="Choose another table"
          onClick={() => setTarget(null)}
        >
          <ArrowLeft size={14} />
        </button>
        <span className="relation-setup-chip">
          <Table2 size={12} />
          {table.name}
          <ArrowRight size={12} />
          <Table2 size={12} />
          {target.name}
        </span>
      </div>
      <div className="relation-setup-option">
        <div>
          <div className="relation-setup-option-title">Link to several rows</div>
          <div className="relation-setup-option-hint">
            {many
              ? `A row can link to any number of rows in ${target.name}.`
              : `Each row links to at most one row in ${target.name}.`}
          </div>
        </div>
        <Switch checked={many} onCheckedChange={setMany} aria-label="Link to several rows" />
      </div>
      <div className="relation-setup-option">
        <div>
          <div className="relation-setup-option-title">
            {self ? "Show the links back" : `Show on ${target.name}`}
          </div>
          <div className="relation-setup-option-hint">
            {self
              ? "Adds a field listing the rows that link to each row."
              : `Adds a field to ${target.name} listing the ${table.name} rows that link to it.`}
          </div>
        </div>
        <Switch checked={back} onCheckedChange={setBack} aria-label={`Show on ${target.name}`} />
      </div>
      {back && (
        <label className="relation-setup-field">
          <span>Field name on {target.name}</span>
          <input
            className="table-input"
            aria-label={`Field name on ${target.name}`}
            value={reverse}
            maxLength={100}
            onChange={(e) => setReverse(e.target.value)}
          />
          {taken && (
            <small className="relation-setup-error">
              {target.name} already has a field named “{name}”.
            </small>
          )}
        </label>
      )}
      <p className="relation-setup-summary">
        Each {table.name} row links to {many ? "any number of rows" : "one row"} in {target.name}.
        {back && name && ` ${target.name} gets a “${name}” field.`}
      </p>
      <div className="relation-setup-actions">
        <button type="button" className="table-button ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="table-button solid"
          disabled={(back && !name) || taken}
          onClick={() =>
            onSubmit({
              target: target.path,
              cardinality: many ? "many" : "one",
              reverse: back ? name : null,
            })
          }
        >
          {submit}
        </button>
      </div>
    </div>
  );
}
