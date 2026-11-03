import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Search, Table2 } from "lucide-react";
import { rankTables, type TableInfo } from "@/lib/tables";

/**
 * Databases to choose from, nearest first (D82): this page's, then the rest of its top-level
 * page's, then (behind "Show all") everything else. Typing a search shows all matches.
 */
export function RankedTables({
  tables,
  pagePath,
  onPick,
  label = "Database",
  autoFocus = false,
  tag,
  trailing,
}: {
  tables: TableInfo[] | null;
  pagePath: string;
  onPick: (table: TableInfo) => void;
  label?: string;
  autoFocus?: boolean;
  /** A short note after a table's name, e.g. "this table". */
  tag?: (table: TableInfo) => string | null;
  trailing?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [all, setAll] = useState(false);
  const q = search.trim().toLowerCase();
  const groups = useMemo(
    () =>
      rankTables(
        (tables ?? []).filter(
          (t) => !q || t.name.toLowerCase().includes(q) || t.page_path.toLowerCase().includes(q),
        ),
        pagePath,
      ),
    [tables, pagePath, q],
  );
  // Other pages stay folded until asked for, unless they are all there is or a search runs.
  const folded = (key: string) => key === "other" && !all && !q && groups.length > 1;
  return (
    <div className="relation-setup ranked-tables">
      <label className="relation-setup-search">
        <Search size={13} />
        <input
          autoFocus={autoFocus}
          placeholder="Search databases"
          aria-label="Search databases"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="relation-setup-list" role="listbox" aria-label={label}>
        {tables === null && <div className="relation-setup-empty">Loading…</div>}
        {tables !== null && !groups.length && (
          <div className="relation-setup-empty">
            {q ? "No databases match." : "There are no databases yet."}
          </div>
        )}
        {groups.map((group) =>
          folded(group.key) ? (
            <button
              key={group.key}
              type="button"
              className="relation-setup-table muted"
              onClick={() => setAll(true)}
            >
              <ChevronDown size={14} />
              <span className="relation-setup-table-name">
                Show all databases ({group.tables.length} more)
              </span>
            </button>
          ) : (
            <div key={group.key} className="relation-setup-folder">
              <div className="relation-setup-folder-name">{group.label}</div>
              {group.tables.map((t) => (
                <button
                  key={t.path}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="relation-setup-table"
                  onClick={() => onPick(t)}
                >
                  <Table2 size={14} />
                  <span className="relation-setup-table-name">{t.name}</span>
                  {tag?.(t) && <span className="relation-setup-tag">{tag(t)}</span>}
                  {group.key !== "here" && (
                    <span className="relation-setup-page">{t.page_path}</span>
                  )}
                  <span className="relation-setup-count">{t.row_count}</span>
                  {trailing}
                </button>
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
