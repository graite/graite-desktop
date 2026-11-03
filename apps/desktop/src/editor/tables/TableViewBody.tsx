import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Code2,
  Columns3,
  Info,
  Link2,
  EyeOff,
  Loader2,
  Plus,
  Sigma,
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
  tables,
  type FileLink,
  type RelationLink,
  type RowOp,
  type TableRow,
  type TableColumn,
} from "@/lib/tables";
import type { PageProperty } from "@/lib/workspace";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import { ArrangeItems } from "../views/ArrangeItems";
import { SortButton } from "../views/SortButton";
import { AddViewFilter, ViewFilterPills } from "../views/ViewFilters";
import { ViewSearch } from "../views/ViewSearch";
import type { ViewFilter } from "../views/settings";
import {
  asProperty,
  CHOICE_TYPES,
  formatNumber,
  NUMERIC_TYPES,
  shownAs,
  TABLE_TYPES,
  TypeIcon,
  typeLabel,
  type TableType,
} from "./columns";
import { filterToRules, rulesToFilter } from "./filters";
import { FormulaEditor, type FormulaChoice } from "./FormulaEditor";
import { RelationSetup, type RelationChoice } from "./RelationSetup";
import { RowPanel, type OpenRow } from "./RowPanel";
import { uploadAll } from "./linkcells";
import { emptySelection, TableGrid } from "./TableGrid";
import { DatabaseSetup } from "./DatabaseSetup";
import { CurrencyList, CurrencyRow, DecimalsChoice } from "./NumberFormat";
import { ViewTabs } from "./ViewTabs";
import { BoardView } from "../views/BoardView";
import { ListView } from "../views/ListView";
import { orderedNames } from "../views/settings";
import { BOARD_ROWS, defaultShown, groupColumns, useTableBoard } from "./tableBoard";
import { cleanView, parseViews, type TableLayout, type TableViewDef } from "./views";
import { useTableRows } from "./useTableRows";
import { useProposals } from "@/review/useProposals";
import "../views/views.css";
import "./tables.css";

export interface TableViewProps {
  /** JSON list of named views (D79); "" for a block still in the older source/tabs form. */
  views: string;
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

/** Set once the viewer hides the "add fields, link databases" tip on a new database. */
const HINT_KEY = "graite.tables.fieldsTip";

/** An older block (one `source`, D68) read as a single view; written as `views:` on its first
 *  change, when any `tabs:` it kept for other tables are dropped (D82). */
function legacyView(raw: TableViewProps): TableViewDef[] {
  if (!raw.source) return [];
  const layout = (["table", "board", "list"] as const).find((k) => k === raw.view);
  return [
    {
      name: "Table",
      source: raw.source,
      ...(layout && layout !== "table" ? { view: layout } : {}),
      filter: raw.filter || undefined,
      sort: raw.sort ? (list(raw.sort) ?? raw.sort) : undefined,
      columns: list(raw.columns) ?? undefined,
    },
  ];
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

/** What a new column needs besides its name and type. */
interface FieldSetup {
  relation?: RelationChoice;
  formula?: FormulaChoice;
}

/** Name and type of a new column: used by the "+" after the last column and by Fields.
 *  A relation asks next which table it links to, a formula for its expression. */
function NewFieldForm({
  table,
  columns,
  link = false,
  onCreate,
  onCancel,
}: {
  table: { path: string; name: string };
  /** The table's fields, which a formula can read. */
  columns: TableColumn[];
  /** Start at choosing the database to link to; the field is named after it. */
  link?: boolean;
  onCreate: (name: string, type: TableType, setup?: FieldSetup) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<TableType>("text");
  const [linking, setLinking] = useState(link);
  const [writing, setWriting] = useState(false);
  if (writing)
    return (
      <div className="table-new-field">
        <small>New formula “{name.trim()}”</small>
        <FormulaEditor
          path={table.path}
          columns={columns}
          column={null}
          submit="Create field"
          onSubmit={(formula) => onCreate(name.trim(), "formula", { formula })}
          onCancel={() => setWriting(false)}
        />
      </div>
    );
  if (linking)
    return (
      <div className="table-new-field">
        {name.trim() && <small>New field “{name.trim()}”</small>}
        <RelationSetup
          table={table}
          submit="Create field"
          onSubmit={(relation) =>
            onCreate(name.trim() || freeField(columns, tableName(relation.target)), "relation", {
              relation,
            })
          }
          onCancel={() => (link ? onCancel() : setLinking(false))}
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
        else if (type === "formula") setWriting(true);
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
          {type === "relation" || type === "formula" ? "Next" : "Create field"}
        </button>
      </div>
    </form>
  );
}

export function TableViewBody({
  id,
  props: raw,
  editor,
}: {
  id: string;
  props: TableViewProps;
  editor: GraiteEditor;
}) {
  // Named views (D79): the shown view's filter, sort and columns stand in for the block's own,
  // so everything below reads `props` the same way in both forms.
  const defs = useMemo(() => {
    const views = parseViews(raw.views);
    return views.length ? views : legacyView(raw);
  }, [raw]);
  const named = defs.length > 0;
  const [active, setActive] = useState(0);
  const at = Math.min(active, Math.max(0, defs.length - 1));
  const current: TableViewDef | null = named ? defs[at]! : null;
  const props: TableViewProps = useMemo(
    () =>
      current
        ? {
            ...raw,
            source: current.source,
            filter: current.filter ?? "",
            sort: Array.isArray(current.sort) ? JSON.stringify(current.sort) : (current.sort ?? ""),
            columns: current.columns ? JSON.stringify(current.columns) : "",
            tabs: "",
          }
        : raw,
    [raw, current],
  );
  const layout: TableLayout = current?.view ?? "table";
  const { pagePath, navigate, openRow: openFullRow } = useContext(MediaContext);
  const dismissSurface = useDismissableLayerSurface();
  const [path, setPath] = useState<string | null>(null);
  const [missing, setMissing] = useState("");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ column: TableColumn; bounds: Rectangle } | null>(null);
  const [rename, setRename] = useState("");
  const [propsOpen, setPropsOpen] = useState(false);
  // The Fields menu's form: a new field, or a link to another database (D82).
  const [addingField, setAddingField] = useState<false | "field" | "link">(false);
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const [customDraft, setCustomDraft] = useState(props.filter);
  const [fieldAnchor, setFieldAnchor] = useState<DOMRect | null>(null);
  const [openRow, setOpenRow] = useState<OpenRow | null>(null);
  // A new card or list row being named.
  const [draftRow, setDraftRow] = useState(false);
  // Switching a column to Relation: the setup opens in its own popover under the header.
  const [linking, setLinking] = useState<{ column: TableColumn; bounds: Rectangle } | null>(null);
  // Editing a formula column's expression, in its own popover under the header (D75).
  const [editing, setEditing] = useState<{ column: TableColumn; bounds: Rectangle } | null>(null);
  const [confirmDuplicates, setConfirmDuplicates] = useState(false);
  // The column menu shows the currency list in place of its items.
  const [pickingCurrency, setPickingCurrency] = useState(false);
  const [hintSeen, setHintSeen] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [confirmType, setConfirmType] = useState<{
    column: TableColumn;
    type: TableType;
    spec: Record<string, unknown>;
    total: number;
    invalid: number;
    examples: string[];
  } | null>(null);

  /** Write the views (the block then holds only them), and show `select` when given. */
  const writeViews = useCallback(
    (next: TableViewDef[], select?: number) => {
      editor.updateBlock(id, {
        type: "tableView",
        props: {
          views: JSON.stringify(next.map(cleanView)),
          source: "",
          view: "",
          filter: "",
          sort: "",
          columns: "",
          tabs: "",
          embed: false,
        },
      });
      if (select !== undefined) setActive(select);
    },
    [editor, id],
  );
  const patchView = useCallback(
    (patch: Partial<TableViewDef>) =>
      writeViews(defs.map((v, n) => (n === at ? { ...v, ...patch } : v))),
    [defs, at, writeViews],
  );
  const update = useCallback(
    (next: Partial<TableViewProps>) => {
      if (!named) return editor.updateBlock(id, { type: "tableView", props: next });
      const patch: Partial<TableViewDef> = {};
      if (next.source) patch.source = next.source;
      if ("filter" in next) patch.filter = next.filter || undefined;
      if ("sort" in next) patch.sort = next.sort ? (list(next.sort) ?? next.sort) : undefined;
      if ("columns" in next)
        patch.columns = next.columns ? (list(next.columns) ?? undefined) : undefined;
      if (Object.keys(patch).length) patchView(patch);
    },
    [editor, id, named, patchView],
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
      // A board or list needs every field (its group, its card fields), not the table's.
      columns: layout === "table" && shown?.length ? shown : undefined,
      search: search.trim() || undefined,
    }),
    // `shown` is derived from props.columns.
    [props.filter, props.sort, props.columns, search, layout],
  );
  const { meta, error, row, ensure, reload, patch, expectOwn } = useTableRows(path, query);

  // A short loader when the view or table changes, so the switch reads as one (it is fast).
  const viewKey = `${at}|${props.source}|${layout}`;
  const [switching, setSwitching] = useState(false);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    setSwitching(true);
    const timer = setTimeout(() => setSwitching(false), 280);
    return () => clearTimeout(timer);
  }, [viewKey]);

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
    (field: string) => {
      const column = columns.find((c) => c.name === field);
      return NUMERIC_TYPES.includes(column ? shownAs(column).type : "");
    },
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
    const column = columns.find((c) => c.name === field);
    const type = column ? shownAs(column).type : "text";
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

  const group = current?.group;
  const cardFields = current?.show ?? (meta ? defaultShown(meta, group) : []);
  const board = useTableBoard({ meta, row, ensure, group, show: cardFields, write });
  const boardLayout = {
    order: current?.boards?.order ?? [],
    hidden: current?.boards?.hidden ?? [],
  };
  /** Table, board or list. An older block becomes a views block on its first other layout. */
  const setLayout = (kind: TableLayout) => {
    const patchFor = (g?: string): Partial<TableViewDef> => ({
      view: kind,
      ...(kind === "board" && !g && groupColumns(meta)[0]
        ? { group: groupColumns(meta)[0]!.name }
        : {}),
    });
    if (named) patchView(patchFor(current?.group));
  };
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

  /** New fields on this table stay in sight: a saved field list only shows the fields it
   *  names, so add them to it. (Another table's views keep their own lists.) */
  const reveal = (table: string, names: string[]) => {
    if (!names.length || table !== path) return;
    if (shown) setShown([...shown, ...names.filter((n) => !shown.includes(n))]);
  };

  const addField = (name: string, type: TableType, setup: FieldSetup = {}) => {
    if (!path) return;
    const { relation, formula } = setup;
    setAddingField(false);
    setPropsOpen(false);
    setFieldAnchor(null);
    void run(async () => {
      if (formula) {
        // A formula lives in the schema only; the CSV gets no column (D75).
        await tables.schema(path, { columns: { [name]: { type: "formula", ...formula } } });
        return;
      }
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

  const openLink = useCallback((column: TableColumn, link: RelationLink) => {
    const target = column.target;
    if (!target) return;
    // Open once the grid is done with this click, and with nothing selected in it, so no
    // cell editor can start behind the panel.
    setSelection(emptySelection());
    setTimeout(() => setOpenRow({ table: target, id: link.id }), 0);
  }, []);

  const openFile = useCallback(
    (table: string, file: FileLink) =>
      void tables.openFile(table, file).catch((e: Error) => toast.error(e.message)),
    [],
  );
  const openPage = useCallback((target: string) => navigate?.(target), [navigate]);

  /** Files dropped on a file cell: upload them, then add them to the cell (D76). */
  const dropFiles = useCallback(
    async (record: TableRow, column: TableColumn, files: File[]) => {
      if (!path || !meta) return;
      const single = column.cardinality === "one";
      const added = await uploadAll(path, single ? files.slice(0, 1) : files);
      if (!added.length) return;
      const at = meta.visible.indexOf(column.name);
      const current = (record.cells[at] as FileLink[] | null) ?? [];
      const next = single ? added : [...current, ...added];
      void write(
        [
          {
            op: "update",
            id: record.id,
            values: { [column.name]: next },
            base: { [column.name]: current },
          },
        ],
        [[record.id, at, next]],
      );
    },
    [path, meta, write],
  );

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
        <DatabaseSetup blockId={id} onViews={(views) => writeViews(views, 0)} />
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
          pagePath ? (
            <ViewTabs
              pagePath={pagePath}
              views={defs}
              active={at}
              meta={meta}
              onSelect={(index) => {
                setActive(index);
                setSearch("");
                setSelection(emptySelection());
              }}
              onChange={writeViews}
              onLayout={setLayout}
              onTableChanged={reload}
            />
          ) : null
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
          <SortButton
            fields={columns.map((c) => c.name)}
            value={sorted && { field: sorted[0], direction: sorted[1] ? "desc" : "asc" }}
            onChange={(next) => update({ sort: next ? `${next.field} ${next.direction}` : "" })}
          />
          {layout === "board" && (
            <Popover>
              <PopoverTrigger className="view-button" aria-label="Group by">
                <Columns3 size={13} />
                {group ?? "Group by"}
              </PopoverTrigger>
              <PopoverContent align="end" className="view-menu">
                <small>Columns by</small>
                {groupColumns(meta).map((c) => (
                  <button
                    key={c.name}
                    className="view-menu-item"
                    onClick={() => patchView({ group: c.name, boards: undefined })}
                  >
                    <TypeIcon type={c.type} size={14} />
                    {c.name}
                    {c.name === group && <Check size={13} className="ml-auto" />}
                  </button>
                ))}
                {!groupColumns(meta).length && (
                  <small>Add a status or select field to group by.</small>
                )}
                {board.groupField && (
                  <>
                    <small>Columns · drag to reorder</small>
                    <ArrangeItems
                      names={orderedNames(
                        [
                          ...board.groupField.options,
                          ...(board.source?.rows.map((r) => board.source!.group(r)) ?? []),
                          "",
                        ],
                        boardLayout.order,
                      )}
                      label={(name) => <>{name || `No ${board.groupField!.name}`}</>}
                      shown={(name) => !boardLayout.hidden.includes(name)}
                      onToggle={(name) =>
                        patchView({
                          boards: {
                            ...boardLayout,
                            hidden: boardLayout.hidden.includes(name)
                              ? boardLayout.hidden.filter((n) => n !== name)
                              : [...boardLayout.hidden, name],
                          },
                        })
                      }
                      onOrder={(order) => patchView({ boards: { ...boardLayout, order } })}
                    />
                  </>
                )}
              </PopoverContent>
            </Popover>
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
                  columns={columns}
                  link={addingField === "link"}
                  onCreate={addField}
                  onCancel={() => setAddingField(false)}
                />
              ) : (
                <>
                  <small>
                    {layout === "table" ? "Fields in this view" : "Shown on cards"} · drag to
                    reorder
                  </small>
                  {layout !== "table" ? (
                    <ArrangeItems
                      names={[
                        ...cardFields,
                        ...columns.map((c) => c.name).filter((n) => !cardFields.includes(n)),
                      ]}
                      label={(name) => (
                        <>
                          <TypeIcon type={columns.find((c) => c.name === name)?.type ?? "text"} />
                          {name}
                        </>
                      )}
                      shown={(name) => cardFields.includes(name)}
                      onToggle={(name) =>
                        patchView({
                          show: cardFields.includes(name)
                            ? cardFields.filter((n) => n !== name)
                            : [...cardFields, name],
                        })
                      }
                      onOrder={(order) =>
                        patchView({ show: order.filter((n) => cardFields.includes(n)) })
                      }
                    />
                  ) : (
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
                  )}
                  {shown && layout === "table" && (
                    <button className="view-menu-item" onClick={() => setShown(null)}>
                      Show all fields
                    </button>
                  )}
                  <button
                    className="view-menu-item view-menu-add"
                    onClick={() => setAddingField("field")}
                  >
                    <Plus size={13} />
                    New field
                  </button>
                  <button
                    className="view-menu-item view-menu-add"
                    onClick={() => setAddingField("link")}
                  >
                    <Link2 size={13} />
                    Link to another database
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
      {meta && !hintSeen && columns.length < 3 && !columns.some((c) => c.type === "relation") && (
        <div className="table-hint">
          <Info size={13} />
          <span>
            Add fields with <b>Fields → New field</b>. To connect rows to another database (say
            books to authors), use <b>Fields → Link to another database</b>.
          </span>
          <button
            type="button"
            className="table-hint-close"
            aria-label="Hide tip"
            onClick={() => {
              setHintSeen(true);
              try {
                localStorage.setItem(HINT_KEY, "1");
              } catch {
                // Storage can be unavailable; the tip then shows again next time.
              }
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}
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
      ) : meta && layout !== "table" ? (
        <div className={`table-board ${switching ? "switching" : ""}`}>
          {board.more > 0 && (
            <div className="table-warning">
              <TriangleAlert size={13} />
              <span>
                Showing the first {BOARD_ROWS} of {total} rows. Narrow it down with a filter.
              </span>
            </div>
          )}
          {!board.source ? null : layout === "list" ? (
            <ListView
              source={board.source}
              draft={draftRow}
              onDraftDone={() => setDraftRow(false)}
              onOpen={(r) => path && setOpenRow({ table: path, id: r.id })}
            />
          ) : board.groupField ? (
            <BoardView
              source={board.source}
              groupField={board.groupField}
              board={boardLayout}
              onBoard={(next) => patchView({ boards: next })}
              draft={draftRow ? (board.groupField.options[0] ?? "") : null}
              onDraftDone={() => setDraftRow(false)}
              onOpen={(r) => path && setOpenRow({ table: path, id: r.id })}
            />
          ) : (
            <div className="table-empty">
              Choose a status or select field to group by, under the board button in the toolbar.
            </div>
          )}
        </div>
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
            setEditing(null);
            setMenu({ column, bounds });
          }}
          onOpenLink={openLink}
          onOpenRow={(r) => {
            setSelection(emptySelection());
            if (path) setTimeout(() => setOpenRow({ table: path, id: r.id }), 0);
          }}
          table={path ?? undefined}
          onOpenFile={openFile}
          onOpenPage={openPage}
          onDropFiles={(record, column, files) => void dropFiles(record, column, files)}
        />
      ) : (
        <div className="table-empty">Loading…</div>
      )}
      {(switching || (!!path && !meta && !error && !missing)) && (
        <div className="table-switching" role="status" aria-label="Loading">
          <Loader2 size={16} className="animate-spin" />
        </div>
      )}
      {meta && !missing && !error && (layout === "table" || layout === "list") && (
        <button
          type="button"
          className="table-new-row"
          onClick={() =>
            layout === "list" ? setDraftRow(true) : void write([{ op: "insert", values: {} }])
          }
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
              columns={columns}
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
          setPickingCurrency(false);
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
          {menu && pickingCurrency ? (
            <CurrencyList
              value={menu.column.currency || "EUR"}
              onBack={() => setPickingCurrency(false)}
              onPick={(currency) => {
                setSchema(menu.column.name, { currency });
                setPickingCurrency(false);
                setMenu(null);
              }}
            />
          ) : (
            menu && (
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
                {menu.column.type === "formula" && (
                  <>
                    <div className="table-menu-note info mono" title={menu.column.formula ?? ""}>
                      <Sigma size={13} />
                      {menu.column.formula}
                    </div>
                    <button
                      className="view-menu-item"
                      onClick={() => {
                        setEditing({ column: menu.column, bounds: menu.bounds });
                        setMenu(null);
                      }}
                    >
                      <Sigma size={14} /> Edit formula…
                    </button>
                  </>
                )}
                {!menu.column.reverse && menu.column.type !== "formula" && (
                  <Popover>
                    <PopoverTrigger className="view-menu-item">
                      <TypeIcon type={menu.column.type} size={14} />
                      Type
                      <span className="table-menu-value">{typeLabel(menu.column.type)}</span>
                      <ChevronRight size={13} />
                    </PopoverTrigger>
                    <PopoverContent
                      side="right"
                      align="start"
                      className="view-menu table-type-menu"
                    >
                      {TABLE_TYPES.filter(([type]) => type !== "formula").map(([type, label]) => (
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
                {NUMERIC_TYPES.includes(shownAs(menu.column).type) && (
                  <>
                    {shownAs(menu.column).type === "currency" && (
                      <CurrencyRow
                        value={menu.column.currency || "EUR"}
                        onOpen={() => setPickingCurrency(true)}
                      />
                    )}
                    <DecimalsChoice
                      value={menu.column.decimals}
                      example={(decimals) => formatNumber({ ...menu.column, decimals }, 1234.5)}
                      onChange={(decimals) => {
                        setSchema(menu.column.name, { decimals });
                        setMenu({ ...menu, column: { ...menu.column, decimals } });
                      }}
                    />
                  </>
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
            )
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
      <Popover open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <PopoverAnchor asChild>
          <span
            style={{
              position: "fixed",
              left: editing?.bounds.x ?? 0,
              top: (editing?.bounds.y ?? 0) + (editing?.bounds.height ?? 0),
              width: editing?.bounds.width ?? 0,
              height: 0,
            }}
          />
        </PopoverAnchor>
        <PopoverContent align="start" className="view-menu formula-popover">
          {editing && path && (
            <FormulaEditor
              path={path}
              columns={columns.filter((c) => c.name !== editing.column.name)}
              column={editing.column.name}
              initial={{
                formula: editing.column.formula ?? "",
                format: editing.column.format ?? "number",
                currency: editing.column.currency ?? "EUR",
                decimals: editing.column.decimals ?? null,
              }}
              submit="Save formula"
              onSubmit={(formula) => {
                setSchema(editing.column.name, { ...formula });
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          )}
        </PopoverContent>
      </Popover>
      <RowPanel
        row={openRow}
        onClose={() => setOpenRow(null)}
        onOpenPage={openPage}
        onOpenFull={openFullRow ? (r) => openFullRow(r.table, r.id) : undefined}
        onOpenTable={(table) => {
          if (table === path) return true;
          // One database per block (D82): another table opens on the page that holds it.
          const [page] = table.split("/_data/");
          if (!page || !navigate) return false;
          navigate(page);
          return true;
        }}
      />
    </div>
  );
}

/** `base`, or `base 2`, ... when the table already has a field by that name. */
function freeField(columns: TableColumn[], base: string): string {
  const taken = new Set(columns.map((c) => c.name.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

/** A table's name from its path (`Clients/_data/companies.csv` -> companies). */
function tableName(path: string | null | undefined): string {
  if (!path) return "a missing table";
  return (path.split("/").pop() ?? path).replace(/\.csv$/i, "");
}
