import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Info,
  Library,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Table2,
  Tag,
} from "lucide-react";
import { toast } from "sonner";
import { onDaemonEvent } from "@/lib/api";
import { tables, type TableInfo } from "@/lib/tables";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TypeIcon } from "./columns";
import type { TableMeta } from "./useTableRows";

/** Tables grouped by the page whose `_data/` holds them, pages in path order. */
export function byFolder(list: TableInfo[]): [string, TableInfo[]][] {
  const groups = new Map<string, TableInfo[]>();
  for (const t of [...list].sort((a, b) => a.path.localeCompare(b.path)))
    groups.set(t.page_path, [...(groups.get(t.page_path) ?? []), t]);
  return [...groups];
}

/** One field in the Name or Detail submenu, checked when it is the current choice. */
function FieldChoice({
  label,
  type,
  chosen,
  onSelect,
}: {
  label: string;
  type?: string;
  chosen: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      {type ? <TypeIcon type={type} size={14} /> : <span className="table-menu-icon-gap" />}
      {label}
      {chosen && <Check className="ml-auto" />}
    </DropdownMenuItem>
  );
}

function NameInput({
  initial,
  placeholder,
  onDone,
}: {
  initial: string;
  placeholder: string;
  onDone: (name: string | null) => void;
}) {
  const [name, setName] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      className="table-tab-input"
      autoFocus
      value={name}
      placeholder={placeholder}
      aria-label={placeholder}
      maxLength={120}
      size={Math.max(8, name.length + 1)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => finish(name.trim() && name.trim() !== initial ? name.trim() : null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(name.trim() && name.trim() !== initial ? name.trim() : null);
        else if (e.key === "Escape") finish(null);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/**
 * The tables in the same `_data/` folder as the shown one, as tabs (D71). The active tab's
 * menu renames the table (its file) and picks the fields that name its rows in links; "+"
 * adds a table to the folder; "All tables" opens a table from any folder.
 */
export function TableTabs({
  meta,
  onSwitch,
  onChanged,
}: {
  meta: TableMeta;
  onSwitch: (table: TableInfo) => void;
  /** The shown table's settings changed (reload its rows). */
  onChanged: () => void;
}) {
  const [siblings, setSiblings] = useState<TableInfo[]>([]);
  const [all, setAll] = useState<TableInfo[] | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    tables
      .list(meta.page_path)
      .then((list) => live && setSiblings(list))
      .catch(() => live && setSiblings([]));
    return () => {
      live = false;
    };
  }, [meta.page_path, meta.path, version]);

  useEffect(
    () =>
      onDaemonEvent((e) => {
        if (e.type === "tables_changed" || e.type === "table_renamed") setVersion((v) => v + 1);
      }),
    [],
  );

  const list = useMemo(
    () =>
      siblings.some((t) => t.path === meta.path)
        ? siblings
        : [...siblings, { ...meta, hash: meta.hash } as TableInfo],
    [siblings, meta],
  );
  // Fields that can name a row: not the id, and not links to other rows.
  const fields = meta.columns.filter((c) => c.name !== meta.primary_key && c.type !== "relation");

  const rename = (name: string | null) => {
    setRenaming(false);
    if (!name) return;
    tables
      .rename(meta.path, name)
      .then(() => setVersion((v) => v + 1))
      .catch((e: Error) => toast.error(e.message));
  };
  const create = (name: string | null) => {
    setAdding(false);
    if (!name) return;
    tables
      .create(meta.page_path, name, ["name"])
      .then((table) => {
        setVersion((v) => v + 1);
        onSwitch(table);
      })
      .catch((e: Error) => toast.error(e.message));
  };
  const setDisplay = (key: "display" | "display_secondary", value: string) => {
    // Links elsewhere store the label: rewrite them when the naming field changes.
    tables
      .schema(meta.path, { [key]: value || null })
      .then(() => (key === "display" ? tables.refreshLabels(meta.path) : undefined))
      .then(onChanged)
      .catch((e: Error) => toast.error(e.message));
  };

  return (
    <div className="table-tabs" role="tablist" aria-label="Tables in this folder">
      {list.map((t) =>
        t.path === meta.path ? (
          renaming ? (
            <NameInput key={t.path} initial={t.name} placeholder="Table name" onDone={rename} />
          ) : (
            <DropdownMenu key={t.path} open={menuOpen} onOpenChange={setMenuOpen}>
              <span
                className="table-tab active"
                role="tab"
                aria-selected
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuOpen(true);
                }}
              >
                <Table2 size={13} />
                <span onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
                  {t.name}
                </span>
                <DropdownMenuTrigger className="table-tab-menu" aria-label="Table settings">
                  <MoreHorizontal size={13} />
                </DropdownMenuTrigger>
              </span>
              <DropdownMenuContent align="start" className="table-tab-settings">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="table-menu-label">
                  Shown in links as
                </DropdownMenuLabel>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Tag /> Name
                    <span className="table-menu-current">
                      {meta.display ?? meta.label_column ?? "—"}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="table-tab-fields">
                    <FieldChoice
                      label={
                        meta.label_column && !meta.display
                          ? `Automatic (${meta.label_column})`
                          : "Automatic"
                      }
                      chosen={!meta.display}
                      onSelect={() => setDisplay("display", "")}
                    />
                    <DropdownMenuSeparator />
                    {fields.map((c) => (
                      <FieldChoice
                        key={c.name}
                        label={c.name}
                        type={c.type}
                        chosen={meta.display === c.name}
                        onSelect={() => setDisplay("display", c.name)}
                      />
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Info /> Detail
                    <span className="table-menu-current">{meta.display_secondary ?? "None"}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="table-tab-fields">
                    <p className="table-menu-hint">
                      Shown next to the name, to tell rows with the same name apart.
                    </p>
                    <FieldChoice
                      label="None"
                      chosen={!meta.display_secondary}
                      onSelect={() => setDisplay("display_secondary", "")}
                    />
                    <DropdownMenuSeparator />
                    {fields.map((c) => (
                      <FieldChoice
                        key={c.name}
                        label={c.name}
                        type={c.type}
                        chosen={meta.display_secondary === c.name}
                        onSelect={() => setDisplay("display_secondary", c.name)}
                      />
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    void tables
                      .refreshLabels(meta.path)
                      .then(() => toast.success("Link labels updated."))
                      .catch((e: Error) => toast.error(e.message))
                  }
                >
                  <RefreshCw />
                  <span className="table-menu-two-line">
                    Refresh link labels
                    <small>Update the names stored in other tables</small>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : (
          <button
            key={t.path}
            type="button"
            role="tab"
            aria-selected={false}
            className="table-tab"
            onClick={() => onSwitch(t)}
          >
            {t.name}
          </button>
        ),
      )}
      {adding ? (
        <NameInput initial="" placeholder="New table name" onDone={create} />
      ) : (
        <button
          type="button"
          className="table-tab table-tab-add"
          aria-label="New table"
          title="New table in this folder"
          onClick={() => setAdding(true)}
        >
          <Plus size={13} />
        </button>
      )}
      <Popover
        onOpenChange={(open) => {
          if (open)
            tables
              .list()
              .then(setAll)
              .catch(() => setAll([]));
        }}
      >
        <PopoverTrigger className="table-tab table-tab-all" title="All tables">
          <Library size={13} />
        </PopoverTrigger>
        <PopoverContent align="start" className="view-menu table-all-tables">
          {all === null ? (
            <small>Loading…</small>
          ) : (
            byFolder(all).map(([page, items]) => (
              <div key={page} className="table-folder">
                <small>{page}</small>
                {items.map((t) => (
                  <button
                    key={t.path}
                    className="view-menu-item"
                    disabled={t.path === meta.path}
                    onClick={() => onSwitch(t)}
                  >
                    <Table2 size={14} />
                    {t.name}
                    <span className="view-count ml-auto">{t.row_count}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
