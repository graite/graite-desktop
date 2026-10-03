import { useContext, useEffect, useRef, useState } from "react";
import { FileUp, Plus, Table2 } from "lucide-react";
import { toast } from "sonner";
import { sourceFor, tables, type TableInfo } from "@/lib/tables";
import { MediaContext } from "../media/context";

/** Shown by a table block with no source yet: create a table, import a CSV, or pick one. */
export function TablePicker({ onPick }: { onPick: (source: string) => void }) {
  const { pagePath } = useContext(MediaContext);
  const [existing, setExisting] = useState<TableInfo[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pagePath) return;
    tables
      .list()
      .then(setExisting)
      .catch(() => setExisting([]));
  }, [pagePath]);

  if (!pagePath) return <div className="table-empty">Save the page before adding a table.</div>;

  const run = async (work: () => Promise<TableInfo>) => {
    setBusy(true);
    try {
      onPick(sourceFor(pagePath, await work()));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="table-picker">
      <form
        className="table-picker-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void run(() => tables.create(pagePath, name.trim(), ["name", "notes"]));
        }}
      >
        <Table2 size={15} />
        <input
          className="table-input"
          placeholder="New table name, e.g. expenses"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button type="submit" className="view-button" disabled={busy || !name.trim()}>
          <Plus size={13} /> Create
        </button>
        <button
          type="button"
          className="view-button"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          <FileUp size={13} /> Import CSV
        </button>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (picked) void run(() => tables.import(pagePath, picked));
          }}
        />
      </form>
      {existing.length > 0 && (
        <div className="table-picker-list">
          <div className="table-picker-label">Or show an existing table</div>
          {existing.map((t) => (
            <button
              key={t.path}
              type="button"
              className="table-picker-item"
              onClick={() => onPick(sourceFor(pagePath, t))}
            >
              <span>{t.name}</span>
              <span className="view-count">
                {t.page_path === pagePath ? "this page" : t.page_path} · {t.row_count} rows
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
