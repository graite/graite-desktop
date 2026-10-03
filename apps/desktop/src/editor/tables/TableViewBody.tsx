import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Code2,
  EyeOff,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Trash2,
  TriangleAlert,
  WrapText,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useDismissableLayerSurface } from "@radix-ui/react-dismissable-layer";
import type { GridSelection, Rectangle } from "@glideapps/glide-data-grid";
import { ApiError } from "@/lib/api";
import {
  describeWarning,
  sourceFor,
  tables,
  type RelationLink,
  type RowOp,
  type TableColumn,
  type TableInfo,
} from "@/lib/tables";
import type { PageProperty } from "@/lib/workspace";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import { ArrangeItems } from "../views/ArrangeItems";
import { AddViewFilter, ViewFilterPills } from "../views/ViewFilters";
import { ViewSearch } from "../views/ViewSearch";
import type { ViewFilter } from "../views/settings";
import {
  asProperty,
  CHOICE_TYPES,
  CURRENCIES,
  NUMERIC_TYPES,
  TABLE_TYPES,
  TypeIcon,
  typeLabel,
  type TableType,
} from "./columns";
import { filterToRules, rulesToFilter } from "./filters";
import { RelationSetup, type RelationChoice } from "./RelationSetup";
import { RowPanel, type OpenRow } from "./RowPanel";
import { emptySelection, TableGrid } from "./TableGrid";
import { TablePicker } from "./TablePicker";
import { TableTabs } from "./TableTabs";
import { useTableRows } from "./useTableRows";
import { useProposals } from "@/review/useProposals";
import "../views/views.css";
import "./tables.css";

export interface TableViewProps {
  source: string;
  view: string;
  filter: string;
  sort: string;
  columns: string;
  height: number;
  embed: boolean;
  /** JSON `{ [source]: { filter?, sort?, columns? } }`: the view each other tab keeps. */
  tabs: string;
}

interface TabView {
  filter?: string;
  sort?: string | string[];
  columns?: string[];
}

function tabViews(json: string): Record<string, TabView> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, TabView>)
      : {};
  } catch {
    return {};
  }
}

function list(json: string): string[] | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : null;
  } catch {
    return null;
  }
}

/** The fence's `sort` (text, or a JSON list such as ["-age","name"]) as the API's text form. */
function sortText(sort: string): string {
  return list(sort)?.join(", ") ?? sort;
}

/** The first sort key, for the sort chip: [column, descending]. */
function firstSort(sort: string): [string, boolean] | null {
  const first = sortText(sort).split(",")[0]?.trim();
  if (!first) return null;
  if (first.startsWith("-")) return [first.slice(1).trim(), true];
  const m = /^(.+?)\s+(asc|desc)$/i.exec(first);
  return m ? [m[1]!.replace(/^`|`$/g, ""), m[2]!.toLowerCase() === "desc"] : [first, false];
}

/** Name and type of a new column: used by the "+" after the last column and by Fields.
 *  A relation asks next which table it links to. */
function NewFieldForm({
  table,
  onCreate,
  onCancel,
}: {
  table: { path: string; name: string };
  onCreate: (name: string, type: TableType, relation?: RelationChoice) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<TableType>("text");
  const [linking, setLinking] = useState(false);
  if (linking)
    return (
      <div className="table-new-field">
        <small>New field “{name.trim()}”</small>
        <RelationSetup
          table={table}
          submit="Create field"
          onSubmit={(choice) => onCreate(name.trim(), "relation", choice)}
          onCancel={() => setLinking(false)}
        />
      </div>
    );
  return (
    <form
      className="table-new-field"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        if (type === "relation") setLinking(true);
        else onCreate(name.trim(), type);
      }}
    >
      <input
        className="table-input"
        autoFocus
        placeholder="Field name"
        aria-label="New field name"
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
      />
      <small>Type</small>
      <div className="table-type-list" role="listbox" aria-label="Field type">
        {TABLE_TYPES.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="option"
            aria-selected={t === type}
            className="view-menu-item"
            onClick={() => setType(t)}
          >
            <TypeIcon type={t} size={14} />
            {label}
            {t === type && <Check size={13} className="ml-auto" />}
          </button>
        ))}
      </div>
      <div className="table-form-actions">
        <button type="button" className="table-button ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="table-button solid" disabled={!name.trim()}>
          {type === "relation" ? "Next" : "Create field"}
        </button>
      </div>
    </form>
  );
}

export function TableViewBody({
  id,
  props,
  editor,
}: {
  id: string;
  props: TableViewProps;
  editor: GraiteEditor;
}) {
  const { pagePath } = useContext(MediaContext);
  const dismissSurface = useDismissableLayerSurface();
  const [path, setPath] = useState<string | null>(null);
  const [missing, setMissing] = useState("");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ column: TableColumn; bounds: Rectangle } | null>(null);
  const [rename, setRename] = useState("");
  const [propsOpen, setPropsOpen] = useState(false);
  const [addingField, setAddingField] = useState(false);
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const [customDraft, setCustomDraft] = useState(props.filter);
  const [fieldAnchor, setFieldAnchor] = useState<DOMRect | null>(null);
  const [openRow, setOpenRow] = useState<OpenRow | null>(null);
  // Switching a column to Relation: the setup opens in its own popover under the header.
  const [linking, setLinking] = useState<{ column: TableColumn; bounds: Rectangle } | null>(null);
  const [confirmDuplicates, setConfirmDuplicates] = useState(false);
  const [confirmType, setConfirmType] = useState<{
    column: TableColumn;
    type: TableType;
    spec: Record<string, unknown>;
    total: number;
    invalid: number;
    examples: string[];
  } | null>(null);

  const update = useCallback(
    (next: Partial<TableViewProps>) => editor.updateBlock(id, { type: "tableView", props: next }),
    [editor, id],
  );

  useEffect(() => {
    if (!props.source || !pagePath) return;
    let live = true;
    tables
      .resolve(pagePath, props.source)
      .then((r) => live && (setPath(r.path), setMissing("")))
      .catch((e: Error) => live && (setPath(null), setMissing(e.message)));
    return () => {
      live = false;
    };
  }, [props.source, pagePath]);

  const shown = list(props.columns);
  const query = useMemo(
    () => ({
      filter: props.filter || undefined,
      sort: sortText(props.sort) || undefined,
      columns: shown?.length ? shown : undefined,
      search: search.trim() || undefined,
    }),
    // `shown` is derived from props.columns.
    [props.filter, props.sort, props.columns, search],
  );
  const { meta, error, row, ensure, reload, patch, expectOwn } = useTableRows(path, query);

  // AI row changes to this table that wait for review: their rows are tinted in the grid.
  const { proposals } = useProposals(pagePath ? { page_path: pagePath, status: "pending" } : null);
  const pending = useMemo(
    () => proposals.filter((p) => p.kind === "rows" && p.rows?.table === path),
    [proposals, path],
  );
  const pendingIds = useMemo(
    () =>
      new Set(
        pending.flatMap((p) => p.rows?.ops.map((o) => o.id).filter(Boolean) ?? []) as string[],
      ),
    [pending],
  );
  // Accepting one writes the table as the agent: reload when the pending set changes.
  const pendingKey = pending.map((p) => p.id).join(",");
  const seenPending = useRef(pendingKey);
  useEffect(() => {
    if (seenPending.current === pendingKey) return;
    seenPending.current = pendingKey;
    reload();
  }, [pendingKey, reload]);
  const columns = useMemo(
    () => meta?.columns.filter((c) => c.name !== meta.primary_key) ?? [],
    [meta],
  );
  const fields = useMemo(() => columns.map((c) => asProperty(c)), [columns]);

  // Shown columns: the fence's list, else every column but the row id.
  const visible = useMemo(() => {
    if (!meta) return [];
    const byName = new Map(meta.columns.map((c) => [c.name, c]));
    return meta.visible
      .map((name) => byName.get(name)!)
      .filter((c) => c && (shown?.length || c.name !== meta.primary_key));
  }, [meta, shown]);
  const cellIndex = useMemo(
    () => visible.map((c) => meta?.visible.indexOf(c.name) ?? -1),
    [visible, meta],
  );

  // Filter pills over the fence's filter text. Rules still missing a value live only here.
  const numeric = useCallback(
    (field: string) => NUMERIC_TYPES.includes(columns.find((c) => c.name === field)?.type ?? ""),
    [columns],
  );
  const parsed = useMemo(() => filterToRules(props.filter), [props.filter]);
  const [rules, setRules] = useState<ViewFilter[]>(parsed ?? []);
  useEffect(() => {
    setCustomDraft(props.filter);
    setRules((current) =>
      parsed && rulesToFilter(current, numeric) !== props.filter ? parsed : current,
    );
    // Only an outside change of the fence resets the pills.
  }, [props.filter]);
  const custom = parsed === null;
  const changeRules = (next: ViewFilter[]) => {
    setRules(next);
    const text = rulesToFilter(next, numeric);
    if (text !== props.filter) update({ filter: text });
  };
  const addRule = (field: string) => {
    const type = columns.find((c) => c.name === field)?.type ?? "text";
    const op: ViewFilter["op"] = [...CHOICE_TYPES, ...NUMERIC_TYPES, "checkbox", "date"].includes(
      type,
    )
      ? "equals"
      : "contains";
    changeRules([...rules, { field, op, value: "" }]);
    setOpenFilter(rules.length);
  };

  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 409)
        toast.error("Someone changed these rows meanwhile. The table was reloaded.");
      else toast.error((e as Error).message);
      reload();
    },
    [reload],
  );

  // The file hash the last read or own write saw: edits made here don't reload the rows.
  const hash = useRef<string | undefined>(undefined);
  useEffect(() => {
    hash.current = meta?.hash;
  }, [meta?.hash]);

  const write = useCallback(
    async (ops: RowOp[], optimistic: [string, number, unknown][] = []) => {
      if (!path) return;
      for (const [rowId, cell, value] of optimistic) patch(rowId, cell, value);
      expectOwn();
      try {
        hash.current = (await tables.write(path, ops, hash.current)).hash;
        if (ops.some((o) => o.op !== "update") || !optimistic.length) reload();
      } catch (e) {
        failed(e);
      }
    },
    [path, patch, reload, failed, expectOwn],
  );

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      expectOwn();
      try {
        await work();
        reload();
      } catch (e) {
        failed(e);
      }
    },
    [reload, failed, expectOwn],
  );

  const setSchema = (name: string, spec: Record<string, unknown>) =>
    path && void run(() => tables.schema(path, { columns: { [name]: spec } }));

  /** The option list of a select column changed in a cell editor. */
  const onField = useCallback(
    (column: TableColumn, next: PageProperty, previous: PageProperty) => {
      if (!path) return;
      const gone = previous.options.filter((o) => !next.options.includes(o));
      const added = next.options.filter((o) => !previous.options.includes(o));
      if (gone.length === 1 && added.length === 1)
        void run(() => tables.changeOption(path, column.name, gone[0]!, added[0]!));
      else if (gone.length === 1 && !added.length)
        void run(() => tables.changeOption(path, column.name, gone[0]!, null));
      else
        void run(() =>
          tables.schema(path, {
            columns: { [column.name]: { options: next.options, colors: next.colors } },
          }),
        );
    },
    [path, run],
  );

  const setShown = (names: string[] | null) =>
    update({ columns: names ? JSON.stringify(names) : "" });

  /** New fields on `table` stay in sight: a saved field list (this tab's `columns`, or
   *  another tab's in `tabs`) only shows the fields it names, so add them to it. */
  const reveal = (table: string, names: string[]) => {
    if (!names.length || !pagePath) return;
    if (table === path) {
      if (shown) setShown([...shown, ...names.filter((n) => !shown.includes(n))]);
      return;
    }
    const [page, file] = table.split("/_data/");
    if (!page || !file) return;
    const key = sourceFor(pagePath, {
      path: table,
      page_path: page,
      name: file.replace(/\.csv$/i, ""),
    });
    const views = tabViews(props.tabs);
    const saved = views[key]?.columns;
    if (!saved?.length) return;
    views[key] = { ...views[key], columns: [...saved, ...names.filter((n) => !saved.includes(n))] };
    update({ tabs: JSON.stringify(views) });
  };

  const addField = (name: string, type: TableType, relation?: RelationChoice) => {
    if (!path) return;
    setAddingField(false);
    setPropsOpen(false);
    setFieldAnchor(null);
    void run(async () => {
      if (relation) {
        await tables.addRelation(
          path,
          name,
          relation.target,
          relation.cardinality,
          relation.reverse,
        );
        if (relation.reverse && relation.target !== path)
          reveal(relation.target, [relation.reverse]);
        return;
      }
      // No base hash: adding a column never overwrites an edit made meanwhile.
      await tables.columns(path, [{ op: "add", name }]);
      if (type !== "text") await tables.schema(path, { columns: { [name]: { type } } });
    });
    reveal(path, relation?.reverse && relation.target === path ? [name, relation.reverse] : [name]);
  };

  /** Show another table in this block, keeping each table's view in `tabs`. */
  const switchTo = (table: Pick<TableInfo, "path" | "page_path" | "name">) => {
    if (!pagePath || !meta || table.path === meta.path) return;
    const views = tabViews(props.tabs);
    const current: TabView = {};
    if (props.filter) current.filter = props.filter;
    if (props.sort) current.sort = list(props.sort) ?? props.sort;
    if (props.columns) current.columns = list(props.columns) ?? [];
    const here = sourceFor(pagePath, meta);
    if (Object.keys(current).length) views[here] = current;
    else delete views[here];
    const next = sourceFor(pagePath, table);
    const view = views[next] ?? {};
    delete views[next];
    setSearch("");
    setSelection(emptySelection());
    update({
      source: next,
      filter: view.filter ?? "",
      sort: Array.isArray(view.sort) ? JSON.stringify(view.sort) : (view.sort ?? ""),
      columns: view.columns ? JSON.stringify(view.columns) : "",
      tabs: Object.keys(views).length ? JSON.stringify(views) : "",
      embed: false,
    });
  };

  const openLink = useCallback((column: TableColumn, link: RelationLink) => {
    const target = column.target;
    if (!target) return;
    // Open once the grid is done with this click, and with nothing selected in it, so no
    // cell editor can start behind the panel.
    setSelection(emptySelection());
    setTimeout(() => setOpenRow({ table: target, id: link.id }), 0);
  }, []);

  /** Make an existing column a relation, first asking when some values are no row there. */
  const convertToRelation = async (column: TableColumn, choice: RelationChoice) => {
    if (!path) return;
    try {
      const check = await tables.checkType(path, column.name, "relation", choice.target);
      if (
        check.invalid > 0 &&
        !window.confirm(
          `${check.invalid} of ${check.total} values are not rows of that table` +
            (check.examples.length
              ? ` (e.g. ${check.examples.map((x) => `“${x}”`).join(", ")})`
              : "") +
            ". They stay as they are and show as missing links. Continue?",
        )
      )
        return;
    } catch (e) {
      failed(e);
      return;
    }
    setMenu(null);
    setLinking(null);
    void run(async () => {
      await tables.addRelation(
        path,
        column.name,
        choice.target,
        choice.cardinality,
        choice.reverse,
      );
      if (choice.reverse) reveal(choice.target, [choice.reverse]);
    });
  };

  const selectedRows = selection.rows.toArray();
  const deleteRows = (indexes: number[]) => {
    const ids = indexes.map((i) => row(i)?.id).filter((x): x is string => !!x);
    setSelection(emptySelection());
    if (ids.length) void write(ids.map((rowId) => ({ op: "delete", id: rowId, values: {} })));
  };

  /** Rename from the column menu, on Enter or when the menu closes any other way. */
  const commitRename = () => {
    const to = rename.trim();
    if (!menu || !path || !to || to === menu.column.name) return;
    const from = menu.column.name;
    void run(() => tables.columns(path, [{ op: "rename", name: from, to }]));
    if (shown) setShown(shown.map((n) => (n === from ? to : n)));
    if (props.sort.includes(from)) update({ sort: "" });
    setWidths(({ [from]: width, ...rest }) => (width ? { ...rest, [to]: width } : rest));
  };

  /** Switch a column's type, first asking when some values would not fit it. */
  const changeType = async (column: TableColumn, type: TableType) => {
    if (!path) return;
    if (type === "relation") {
      if (menu) setLinking({ column, bounds: menu.bounds });
      setMenu(null);
      return;
    }
    const spec = { type, ...(type === "currency" ? { currency: column.currency || "EUR" } : {}) };
    try {
      const check = await tables.checkType(path, column.name, type);
      if (check.invalid > 0) {
        setConfirmType({ column, type, spec, ...check });
        return;
      }
    } catch (e) {
      failed(e);
      return;
    }
    setMenu(null);
    setSchema(column.name, spec);
  };

  if (!props.source)
    return (
      <div ref={dismissSurface} className="page-view table-view" contentEditable={false}>
        <TablePicker onPick={(source) => update({ source })} />
      </div>
    );

  const sorted = firstSort(props.sort);
  const total = meta?.total ?? 0;
  const visibleNames = visible.map((c) => c.name);
  const arranged = [
    ...visibleNames,
    ...columns.map((c) => c.name).filter((n) => !visibleNames.includes(n)),
  ];

  const customPill = custom && (
    <Popover>
      <PopoverTrigger className="view-filter-pill" title={props.filter}>
        <Code2 size={13} />
        <span>Custom filter</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="view-filter-popover table-custom-filter">
        <small>Filter as text · and, or, not, in [a, b], contains, is empty</small>
        <textarea
          className="table-input mono"
          rows={3}
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
        />
        <div className="table-custom-actions">
          <button className="view-button" onClick={() => update({ filter: "" })}>
            <X size={12} /> Clear
          </button>
          <button
            className="view-button view-button-primary"
            onClick={() => update({ filter: customDraft.trim() })}
          >
            <Check size={12} /> Apply
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );

  // Nothing here stops events: the grid listens for mouse and clipboard events on `window`,
  // so a stopped event never reaches it. The block is `selectable: false` instead, which makes
  // ProseMirror ignore everything inside it (TableViewBlock.tsx).
  return (
    <div ref={dismissSurface} className="page-view table-view" contentEditable={false}>
      <div className="view-toolbar">
        {meta ? (
          <TableTabs meta={meta} onSwitch={switchTo} onChanged={reload} />
        ) : (
          <span className="table-title">
            <Table2 size={14} />
            {props.source}
          </span>
        )}
        <div className="view-actions">
          <ViewSearch query={search} onQuery={setSearch} placeholder="Search rows…" />
          {!rules.length && !custom && (
            <AddViewFilter fields={fields} onAdd={addRule} titleField={false} />
          )}
          {sorted && (
            <button
              type="button"
              className="view-button table-sort-chip"
              title="Clear sort"
              onClick={() => update({ sort: "" })}
            >
              {sorted[1] ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
              {sorted[0]}
              <X size={12} />
            </button>
          )}
          <Popover
            open={propsOpen}
            onOpenChange={(open) => {
              setPropsOpen(open);
              setAddingField(false);
            }}
          >
            <PopoverTrigger className="view-button" aria-label="Shown fields">
              <SlidersHorizontal size={13} />
              Fields
            </PopoverTrigger>
            <PopoverContent align="end" className="view-menu">
              {addingField ? (
                <NewFieldForm
                  table={{ path: path ?? "", name: meta?.name ?? "" }}
                  onCreate={addField}
                  onCancel={() => setAddingField(false)}
                />
              ) : (
                <>
                  <small>Fields in this view · drag to reorder</small>
                  <ArrangeItems
                    names={arranged}
                    label={(name) => (
                      <>
                        <TypeIcon type={columns.find((c) => c.name === name)?.type ?? "text"} />
                        {name}
                      </>
                    )}
                    shown={(name) => visibleNames.includes(name)}
                    onToggle={(name) =>
                      setShown(
                        visibleNames.includes(name)
                          ? visibleNames.filter((n) => n !== name)
                          : [...visibleNames, name],
                      )
                    }
                    onOrder={(order) => setShown(order.filter((n) => visibleNames.includes(n)))}
                  />
                  {shown && (
                    <button className="view-menu-item" onClick={() => setShown(null)}>
                      Show all fields
                    </button>
                  )}
                  <button
                    className="view-menu-item view-menu-add"
                    onClick={() => setAddingField(true)}
                  >
                    <Plus size={13} />
                    New field
                  </button>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>
        {custom ? (
          <div className="view-filter-pills">{customPill}</div>
        ) : (
          rules.length > 0 && (
            <ViewFilterPills
              fields={fields}
              filters={rules}
              openIndex={openFilter}
              onOpen={setOpenFilter}
              onChange={changeRules}
              onAdd={addRule}
              titleField={false}
            />
          )
        )}
      </div>
      {meta?.warnings?.map((w) => (
        <div key={w} className="table-warning">
          <TriangleAlert size={13} />
          <span>{describeWarning(w)}</span>
          {(w.startsWith("ids_missing") || w.startsWith("ids_blank")) && path && (
            <button
              type="button"
              className="view-button"
              onClick={() => void run(() => tables.ensureIds(path))}
            >
              Add ids now
            </button>
          )}
          {w.startsWith("ids_duplicate") &&
            path &&
            (confirmDuplicates ? (
              <>
                <span>Links keep pointing at the first row with each id.</span>
                <button
                  type="button"
                  className="view-button"
                  onClick={() => {
                    setConfirmDuplicates(false);
                    void run(() => tables.ensureIds(path, true));
                  }}
                >
                  Give new ids
                </button>
                <button
                  type="button"
                  className="view-button"
                  onClick={() => setConfirmDuplicates(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="view-button"
                onClick={() => setConfirmDuplicates(true)}
              >
                Give duplicates new ids…
              </button>
            ))}
        </div>
      ))}
      {pending.length > 0 && (
        <button
          type="button"
          className="table-pending"
          onClick={() =>
            document
              .querySelector(".review-bar")
              ?.scrollIntoView({ behavior: "smooth", block: "center" })
          }
        >
          <Sparkles size={13} />
          {pending.length === 1
            ? "1 AI change to this table awaits review"
            : `${pending.length} AI changes to this table await review`}
        </button>
      )}
      {selectedRows.length > 0 && (
        <div className="table-selection-bar">
          <span>{selectedRows.length} selected</span>
          <button type="button" className="danger" onClick={() => deleteRows(selectedRows)}>
            <Trash2 size={13} /> Delete
          </button>
          <button type="button" onClick={() => setSelection(emptySelection())}>
            Clear
          </button>
        </div>
      )}
      {missing ? (
        <div className="table-empty">
          {missing}{" "}
          <button type="button" className="view-button" onClick={() => update({ source: "" })}>
            Choose a table
          </button>
        </div>
      ) : error ? (
        <div className="table-empty error">{error}</div>
      ) : meta ? (
        <TableGrid
          columns={visible}
          total={total}
          row={row}
          ensure={ensure}
          cellIndex={cellIndex}
          height={props.height || null}
          widths={widths}
          selection={selection}
          onSelection={setSelection}
          onWrite={(ops, optimistic) => void write(ops, optimistic)}
          onInvalid={(message) => toast.error(message)}
          onField={onField}
          onDeleteRows={deleteRows}
          pendingIds={pendingIds}
          onAddField={setFieldAnchor}
          onResize={(name, width, done) => {
            setWidths((w) => ({ ...w, [name]: width }));
            if (done) setSchema(name, { width: Math.round(width) });
          }}
          onMove={(from, to) => {
            const names = [...visibleNames];
            const [moved] = names.splice(from, 1);
            names.splice(to, 0, moved!);
            setShown(names);
          }}
          onHeaderMenu={(column, bounds) => {
            setRename(column.name);
            setLinking(null);
            setMenu({ column, bounds });
          }}
          onOpenLink={openLink}
        />
      ) : (
        <div className="table-empty">Loading…</div>
      )}
      {meta && !missing && !error && (
        <button
          type="button"
          className="table-new-row"
          onClick={() => void write([{ op: "insert", values: {} }])}
        >
          <Plus size={13} /> New
        </button>
      )}
      <Popover open={!!fieldAnchor} onOpenChange={(open) => !open && setFieldAnchor(null)}>
        <PopoverAnchor asChild>
          <span
            style={{
              position: "fixed",
              left: fieldAnchor?.x ?? 0,
              top: fieldAnchor?.bottom ?? 0,
              width: fieldAnchor?.width ?? 0,
              height: 0,
            }}
          />
        </PopoverAnchor>
        <PopoverContent align="end" className="view-menu table-field-menu">
          {fieldAnchor && (
            <NewFieldForm
              table={{ path: path ?? "", name: meta?.name ?? "" }}
              onCreate={addField}
              onCancel={() => setFieldAnchor(null)}
            />
          )}
        </PopoverContent>
      </Popover>
      <Popover
        open={!!menu}
        onOpenChange={(open) => {
          if (open) return;
          commitRename();
          setMenu(null);
          setConfirmType(null);
        }}
      >
        <PopoverAnchor asChild>
          <span
            style={{
              position: "fixed",
              left: menu?.bounds.x ?? 0,
              top: (menu?.bounds.y ?? 0) + (menu?.bounds.height ?? 0),
              width: menu?.bounds.width ?? 0,
              height: 0,
            }}
          />
        </PopoverAnchor>
        <PopoverContent align="start" className="view-menu table-column-menu">
          {menu && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  commitRename();
                  setMenu(null);
                }}
              >
                <input
                  className="table-input"
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  aria-label="Field name"
                />
              </form>
              {menu.column.type === "relation" && (
                <div className="table-menu-note info">
                  <TypeIcon type="relation" size={13} />
                  {menu.column.reverse
                    ? `Rows of ${tableName(menu.column.target ?? menu.column.table)} that link here`
                    : `Links to ${menu.column.cardinality === "one" ? "one row" : "rows"} of ${tableName(menu.column.target ?? menu.column.table)}`}
                </div>
              )}
              {!menu.column.reverse && (
                <Popover>
                  <PopoverTrigger className="view-menu-item">
                    <TypeIcon type={menu.column.type} size={14} />
                    Type
                    <span className="table-menu-value">{typeLabel(menu.column.type)}</span>
                    <ChevronRight size={13} />
                  </PopoverTrigger>
                  <PopoverContent side="right" align="start" className="view-menu table-type-menu">
                    {TABLE_TYPES.map(([type, label]) => (
                      <button
                        key={type}
                        className="view-menu-item"
                        onClick={() => void changeType(menu.column, type)}
                      >
                        <TypeIcon type={type} size={14} />
                        {label}
                        {menu.column.type === type && <Check size={13} className="ml-auto" />}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              )}
              {confirmType && (
                <div className="table-confirm" role="alert">
                  <p>
                    {confirmType.invalid} of {confirmType.total} values don’t read as{" "}
                    {typeLabel(confirmType.type).toLowerCase()}
                    {confirmType.examples.length > 0 &&
                      ` (e.g. ${confirmType.examples.map((x) => `“${x}”`).join(", ")})`}
                    . They stay in the CSV as they are and show in red until you fix them.
                  </p>
                  <div className="table-form-actions">
                    <button
                      type="button"
                      className="table-button ghost"
                      onClick={() => setConfirmType(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="table-button solid"
                      onClick={() => {
                        setSchema(confirmType.column.name, confirmType.spec);
                        setConfirmType(null);
                        setMenu(null);
                      }}
                    >
                      Change type
                    </button>
                  </div>
                </div>
              )}
              {menu.column.invalid > 0 && !confirmType && (
                <div className="table-menu-note">
                  <TriangleAlert size={13} />
                  {menu.column.invalid} value{menu.column.invalid === 1 ? "" : "s"} don’t fit this
                  type
                </div>
              )}
              {menu.column.type === "text" && (
                <button
                  className="view-menu-item"
                  onClick={() => {
                    setSchema(menu.column.name, { wrap: menu.column.wrap ? null : true });
                    setMenu(null);
                  }}
                >
                  <WrapText size={14} /> Wrap text
                  {menu.column.wrap && <Check size={13} className="ml-auto" />}
                </button>
              )}
              {menu.column.type === "currency" && (
                <label className="view-menu-item">
                  Currency
                  <select
                    className="table-menu-value"
                    value={menu.column.currency || "EUR"}
                    onChange={(e) => {
                      setSchema(menu.column.name, { currency: e.target.value });
                      setMenu(null);
                    }}
                  >
                    {CURRENCIES.map((code) => (
                      <option key={code}>{code}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="table-menu-separator" />
              <button
                className="view-menu-item"
                onClick={() => {
                  update({ sort: `${menu.column.name} asc` });
                  setMenu(null);
                }}
              >
                <ArrowUp size={14} /> Sort ascending
              </button>
              <button
                className="view-menu-item"
                onClick={() => {
                  update({ sort: `${menu.column.name} desc` });
                  setMenu(null);
                }}
              >
                <ArrowDown size={14} /> Sort descending
              </button>
              <button
                className="view-menu-item"
                onClick={() => {
                  setShown(visibleNames.filter((n) => n !== menu.column.name));
                  setMenu(null);
                }}
              >
                <EyeOff size={14} /> Hide in this view
              </button>
              <div className="table-menu-separator" />
              <button
                className="view-menu-item danger"
                onClick={() => {
                  if (path)
                    void run(() =>
                      tables.columns(path, [{ op: "delete", name: menu.column.name }]),
                    );
                  if (shown) setShown(shown.filter((n) => n !== menu.column.name));
                  setMenu(null);
                }}
              >
                <Trash2 size={14} /> Delete field
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>
      <Popover open={!!linking} onOpenChange={(open) => !open && setLinking(null)}>
        <PopoverAnchor asChild>
          <span
            style={{
              position: "fixed",
              left: linking?.bounds.x ?? 0,
              top: (linking?.bounds.y ?? 0) + (linking?.bounds.height ?? 0),
              width: linking?.bounds.width ?? 0,
              height: 0,
            }}
          />
        </PopoverAnchor>
        <PopoverContent align="start" className="relation-setup-popover">
          {linking && (
            <RelationSetup
              table={{ path: path ?? "", name: meta?.name ?? "" }}
              submit="Change to relation"
              onSubmit={(choice) => void convertToRelation(linking.column, choice)}
              onCancel={() => setLinking(null)}
            />
          )}
        </PopoverContent>
      </Popover>
      <RowPanel
        row={openRow}
        onClose={() => setOpenRow(null)}
        onOpenTable={(table) => {
          if (table === path) return true;
          const [page, name] = table.split("/_data/");
          if (!page || !name) return false;
          switchTo({ path: table, page_path: page, name: name.replace(/\.csv$/i, "") });
          return true;
        }}
      />
    </div>
  );
}

/** A table's name from its path (`Clients/_data/companies.csv` -> companies). */
function tableName(path: string | null | undefined): string {
  if (!path) return "a missing table";
  return (path.split("/").pop() ?? path).replace(/\.csv$/i, "");
}
