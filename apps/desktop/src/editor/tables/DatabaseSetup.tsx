import { useContext, useEffect, useRef, useState } from "react";
import { ArrowLeft, Database, FileUp, Table2 } from "lucide-react";
import { toast } from "sonner";
import { sourceFor, tables, type TableInfo } from "@/lib/tables";
import { MediaContext } from "../media/context";
import { RankedTables } from "./RankedTables";
import { GroupChoice, LayoutCards, viewOf } from "./ViewTabs";
import { takeSetup, type SetupMode } from "./setup";
import { TABLE_LAYOUTS, type TableLayout, type TableViewDef } from "./views";

const layoutName = (layout: TableLayout) => TABLE_LAYOUTS.find(([k]) => k === layout)![1];

/** An empty database block: make a database here, or link one that exists (D82). */
export function DatabaseSetup({
  blockId,
  onViews,
}: {
  blockId: string;
  /** Show these views here. */
  onViews: (views: TableViewDef[]) => void;
}) {
  const { pagePath } = useContext(MediaContext);
  const [mode, setMode] = useState<SetupMode>(() => takeSetup(blockId) ?? "new");
  const [name, setName] = useState("");
  const [layout, setLayout] = useState<TableLayout>("table");
  const [existing, setExisting] = useState<TableInfo[] | null>(null);
  const [linked, setLinked] = useState<TableInfo | null>(null);
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode !== "linked" || existing) return;
    tables
      .list()
      .then(setExisting)
      .catch(() => setExisting([]));
  }, [mode, existing]);

  if (!pagePath) return <div className="table-empty">Save the page before adding a database.</div>;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** A new table on `page`, with a Status field when it starts as a board. */
  const make = async (page: string): Promise<TableViewDef> => {
    const table = await tables.create(page, name.trim(), ["name", "notes"]);
    const view: TableViewDef = {
      name: layoutName(layout),
      source: sourceFor(page, table),
      view: layout,
    };
    if (layout === "board") view.group = await tables.addStatusField(table);
    return view;
  };

  const create = () => run(async () => onViews([await make(pagePath)]));

  const showLinked = (table: TableInfo) =>
    run(async () =>
      onViews([await viewOf(table, layout, layoutName(layout), sourceFor(pagePath, table), group)]),
    );

  if (mode === "linked")
    return (
      <div className="table-picker database-setup">
        <div className="database-setup-title">
          <Table2 size={15} />
          {linked ? (
            <>
              <button
                type="button"
                className="relation-setup-back"
                aria-label="Choose another database"
                onClick={() => setLinked(null)}
              >
                <ArrowLeft size={14} />
              </button>
              Show <b>{linked.name}</b> here as
            </>
          ) : (
            "Linked view: show a database that already exists"
          )}
        </div>
        {linked ? (
          <>
            <LayoutCards value={layout} onChange={setLayout} />
            {layout === "board" && <GroupChoice table={linked} value={group} onChange={setGroup} />}
            <div className="table-form-actions">
              <button
                type="button"
                className="table-button solid"
                disabled={busy}
                onClick={() => void showLinked(linked)}
              >
                Show {layoutName(layout).toLowerCase()}
              </button>
            </div>
          </>
        ) : (
          <RankedTables tables={existing} pagePath={pagePath} onPick={setLinked} autoFocus />
        )}
        <p className="database-setup-switch">
          Or{" "}
          <button type="button" onClick={() => setMode("new")}>
            make a new database
          </button>
        </p>
      </div>
    );

  return (
    <form
      className="table-picker database-setup"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && !busy) void create();
      }}
    >
      <div className="database-setup-title">
        <Database size={15} />
        New database
        <span className="database-setup-hint">
          Rows with typed fields, saved as a CSV file in this page. Show them as a table, board or
          list.
        </span>
      </div>
      <input
        className="table-input"
        placeholder="Name, e.g. Books"
        aria-label="Database name"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        autoFocus
      />
      <LayoutCards value={layout} onChange={setLayout} />
      {layout === "board" && (
        <p className="table-menu-hint">The board gets a Status field (Todo, Doing, Done).</p>
      )}
      <div className="table-form-actions">
        <button
          type="button"
          className="view-button"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          <FileUp size={13} /> Import CSV
        </button>
        <button type="submit" className="table-button solid" disabled={busy || !name.trim()}>
          Create
        </button>
      </div>
      <input
        ref={file}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (picked)
            void run(async () => {
              const table = await tables.import(pagePath, picked);
              onViews([{ name: "Table", source: sourceFor(pagePath, table), view: "table" }]);
            });
        }}
      />
      <p className="database-setup-switch">
        Or{" "}
        <button type="button" onClick={() => setMode("linked")}>
          show a database that already exists
        </button>
      </p>
    </form>
  );
}
