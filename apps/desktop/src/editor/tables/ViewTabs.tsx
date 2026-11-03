import { useState } from "react";
import {
  Check,
  Copy,
  Kanban,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  Table2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { sourceFor, tables, type TableInfo } from "@/lib/tables";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NameInput, TableNamingItems } from "./TableNaming";
import { TypeIcon } from "./columns";
import type { TableMeta } from "./useTableRows";
import { freeName, moveView, TABLE_LAYOUTS, type TableLayout, type TableViewDef } from "./views";

export const LAYOUT_ICONS: Record<TableLayout, LucideIcon> = {
  table: Table2,
  board: Kanban,
  list: List,
};
const DRAG = "application/graite-table-view";

const LAYOUT_HINTS: Record<TableLayout, string> = {
  table: "Rows and columns, edit like a spreadsheet",
  board: "Cards in columns by a status or select field",
  list: "One line per item with a few fields",
};

/** What the view helpers need of a table (its info or the shown table's meta). */
type TableLike = Pick<TableInfo, "path" | "name" | "columns">;

/** Columns a board can group by. */
const groupable = (t: TableLike | undefined) =>
  (t?.columns ?? []).filter((c) => c.type === "status" || c.type === "single_select");

/** Table, board or list, as cards with a line on what each is for. */
export function LayoutCards({
  value,
  onChange,
}: {
  value: TableLayout;
  onChange: (layout: TableLayout) => void;
}) {
  return (
    <div className="table-layout-cards" role="radiogroup" aria-label="Layout">
      {TABLE_LAYOUTS.map(([kind, text]) => {
        const Icon = LAYOUT_ICONS[kind];
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={value === kind}
            className={`table-layout-card ${value === kind ? "active" : ""}`}
            onClick={() => onChange(kind)}
          >
            <Icon size={16} />
            <b>{text}</b>
            <span>{LAYOUT_HINTS[kind]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A board's grouping: the field it groups by, or a note that a Status field will be added. */
export function GroupChoice({
  table,
  value,
  onChange,
}: {
  table: TableLike;
  value: string;
  onChange: (name: string) => void;
}) {
  const groups = groupable(table);
  return (
    <>
      <small>Columns by</small>
      {groups.length ? (
        <div className="table-group-choices" role="radiogroup" aria-label="Group by">
          {groups.map((c) => (
            <button
              key={c.name}
              type="button"
              role="radio"
              aria-checked={c.name === value}
              className={`view-chip-choice ${c.name === value ? "active" : ""}`}
              onClick={() => onChange(c.name)}
            >
              <TypeIcon type={c.type} size={12} />
              {c.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="table-menu-hint">
          {table.name} has no status or select field yet, so a Status field (Todo, Doing, Done) is
          added to make the columns.
        </p>
      )}
    </>
  );
}

/** The view a layout makes of `table`: a board groups by `group`, or by a new Status field. */
export async function viewOf(
  table: TableLike,
  layout: TableLayout,
  name: string,
  source: string,
  group: string,
): Promise<TableViewDef> {
  if (layout !== "board") return { name, source, view: layout };
  const groups = groupable(table);
  const by = groups.some((c) => c.name === group)
    ? group
    : (groups[0]?.name ?? (await tables.addStatusField(table)));
  return { name, source, view: "board", group: by };
}

/** "+": another view of this block's database, in the layout chosen here. */
function AddView({
  table,
  source,
  views,
  onAdd,
}: {
  table: TableLike;
  source: string;
  views: TableViewDef[];
  onAdd: (view: TableViewDef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<TableLayout>("table");
  const [group, setGroup] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = groupable(table);
  const groupBy = groups.some((c) => c.name === group) ? group : (groups[0]?.name ?? "");
  const suggested = freeName(views, TABLE_LAYOUTS.find(([k]) => k === layout)![1]);
  const reset = () => {
    setGroup("");
    setName("");
    setLayout("table");
  };
  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      onAdd(
        await viewOf(table, layout, freeName(views, name.trim() || suggested), source, groupBy),
      );
      setOpen(false);
      reset();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger className="table-tab table-tab-add" aria-label="New view" title="New view">
        <Plus size={13} />
      </PopoverTrigger>
      <PopoverContent align="start" className="view-menu table-add-view">
        <div className="table-add-view-title">
          New view of <b>{table.name}</b>
        </div>
        <LayoutCards value={layout} onChange={setLayout} />
        {layout === "board" && <GroupChoice table={table} value={groupBy} onChange={setGroup} />}
        <small>Name</small>
        <input
          className="table-input"
          placeholder={suggested}
          aria-label="View name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <div className="table-form-actions">
          <button
            type="button"
            className="table-button solid"
            disabled={busy}
            onClick={() => void add()}
          >
            Add view
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The views of a database block as tabs (D79, D82): all show the same table. Click to show
 * one (nothing is written), drag to reorder, double-click to rename; the active view's menu
 * renames, duplicates, changes the layout or deletes it, and holds the table's own settings.
 */
export function ViewTabs({
  pagePath,
  views,
  active,
  meta,
  onSelect,
  onChange,
  onLayout,
  onTableChanged,
}: {
  pagePath: string;
  views: TableViewDef[];
  active: number;
  meta: TableMeta | null;
  onSelect: (index: number) => void;
  /** The views changed: write them, and show `select` when given. */
  onChange: (views: TableViewDef[], select?: number) => void;
  /** Show the active view in another layout (a board also needs a field to group by). */
  onLayout: (layout: TableLayout) => void;
  onTableChanged: () => void;
}) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const replace = (index: number, view: TableViewDef) =>
    onChange(views.map((v, n) => (n === index ? view : v)));
  const rename = (index: number, name: string | null) => {
    setRenaming(null);
    if (!name) return;
    if (views.some((v, n) => n !== index && v.name.toLowerCase() === name.toLowerCase()))
      return void toast.error(`There is already a view called “${name}”.`);
    replace(index, { ...views[index]!, name });
  };

  return (
    <div className="table-tabs" role="tablist" aria-label="Views">
      {views.map((view, index) => {
        const Icon = LAYOUT_ICONS[view.view ?? "table"] ?? Table2;
        const selected = index === active;
        if (renaming === index)
          return (
            <NameInput
              key={`${view.name}-${index}`}
              initial={view.name}
              placeholder="View name"
              onDone={(name) => rename(index, name)}
            />
          );
        const dragProps = {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(DRAG, String(index));
            e.dataTransfer.effectAllowed = "move";
          },
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG)) return;
            e.preventDefault();
            setOver(index);
          },
          onDragLeave: () => setOver(null),
          onDrop: (e: React.DragEvent) => {
            setOver(null);
            const from = Number(e.dataTransfer.getData(DRAG));
            if (!e.dataTransfer.types.includes(DRAG) || Number.isNaN(from) || from === index)
              return;
            e.preventDefault();
            const shown = views[active];
            const next = moveView(views, from, index);
            onChange(next, shown ? next.indexOf(shown) : 0);
          },
        };
        const className = `table-tab ${selected ? "active" : ""} ${over === index ? "drop" : ""}`;
        if (!selected)
          return (
            <button
              key={`${view.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={false}
              className={className}
              title="Click to show · drag to reorder"
              onClick={() => onSelect(index)}
              onDoubleClick={() => setRenaming(index)}
              {...dragProps}
            >
              <Icon size={13} />
              {view.name}
            </button>
          );
        return (
          <DropdownMenu key={`${view.name}-${index}`}>
            <span className={className} role="tab" aria-selected {...dragProps}>
              <Icon size={13} />
              <span onDoubleClick={() => setRenaming(index)} title="Double-click to rename">
                {view.name}
              </span>
              <DropdownMenuTrigger className="table-tab-menu" aria-label="View settings">
                <MoreHorizontal size={13} />
              </DropdownMenuTrigger>
            </span>
            <DropdownMenuContent align="start" className="table-tab-settings">
              <DropdownMenuItem onSelect={() => setRenaming(index)}>
                <Pencil /> Rename view
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  const copy = { ...view, name: freeName(views, `${view.name} copy`) };
                  const next = [...views.slice(0, index + 1), copy, ...views.slice(index + 1)];
                  onChange(next, index + 1);
                }}
              >
                <Copy /> Duplicate view
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Icon /> Layout
                  <span className="table-menu-current">
                    {TABLE_LAYOUTS.find(([k]) => k === (view.view ?? "table"))?.[1]}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="table-tab-fields">
                  {TABLE_LAYOUTS.map(([kind, text]) => {
                    const LayoutIcon = LAYOUT_ICONS[kind];
                    return (
                      <DropdownMenuItem key={kind} onSelect={() => onLayout(kind)}>
                        <LayoutIcon /> {text}
                        {(view.view ?? "table") === kind && <Check className="ml-auto" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {meta && (
                <>
                  <DropdownMenuSeparator />
                  <TableNamingItems meta={meta} onChanged={onTableChanged} />
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={views.length < 2}
                onSelect={() => {
                  const next = views.filter((_, n) => n !== index);
                  onChange(next, Math.max(0, index - 1));
                }}
              >
                <Trash2 /> Delete view
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      {meta && (
        <AddView
          table={meta}
          source={views[active]?.source ?? sourceFor(pagePath, meta)}
          views={views}
          onAdd={(view) => onChange([...views, view], views.length)}
        />
      )}
    </div>
  );
}
