import { createElement, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type EditListItem,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type SpriteMap,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { parseDateInput } from "@/pages/DateField";
import type { PageProperty } from "@/lib/workspace";
import {
  isRelationLinks,
  type FileLink,
  type RelationLink,
  type RowOp,
  type TableColumn,
  type TableRow,
} from "@/lib/tables";
import { mix, tagsCell, tagsRenderer, type TagsCell } from "./cells";
import { relationCell, relationRenderer, type RelationCell, type RelationData } from "./relations";
import { linksCell, linksRenderer, type LinksCell, type LinksData } from "./linkcells";
import {
  CHOICE_TYPES,
  EMAIL,
  formatValue,
  NUMERIC_TYPES,
  parseNumber,
  shownAs,
  TABLE_TYPES,
  typeIcon,
  URL_RE,
} from "./columns";
import { useGridTheme, type GridColors } from "./theme";

const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 34;
const MARKER_WIDTH = 32;
const PLUS_WIDTH = 34;
const MAX_HEIGHT = 480;
const LINE_HEIGHT = 17;
const MAX_LINES = 8;
// Room under the last row so it stays clear of the overlay horizontal scrollbar.
const SCROLLBAR_ROOM = 12;

let measurer: CanvasRenderingContext2D | null | undefined;

/** Lines `text` takes at `width` pixels when wrapped word by word. */
export function lineCount(text: string, width: number, font: string): number {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer || width <= 0) return 1;
  measurer.font = font;
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    lines++;
    let used = 0;
    for (const word of paragraph.split(/\s+/)) {
      const w = measurer.measureText(word + " ").width;
      if (used > 0 && used + w > width) {
        lines++;
        used = w;
      } else used += w;
    }
  }
  return lines;
}
const RENDERERS = [tagsRenderer, relationRenderer, linksRenderer];

/**
 * Header icons are the page properties' lucide icons, drawn in the header's muted color
 * (`bgColor` is `bgIconHeader`, see theme.ts), without Glide's filled squares.
 */
const HEADER_ICONS: SpriteMap = Object.fromEntries(
  TABLE_TYPES.map(([type]) => type).map((type) => [
    `type-${type}`,
    ({ bgColor }: { bgColor: string }) => {
      const inner = renderToStaticMarkup(
        createElement(typeIcon(type), { color: bgColor, strokeWidth: 2 }),
      ).replace(/^<svg[^>]*>|<\/svg>$/g, "");
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="-4 -4 32 32" ` +
        `fill="none" stroke="${bgColor}" stroke-width="2" stroke-linecap="round" ` +
        `stroke-linejoin="round">${inner}</svg>`
      );
    },
  ]),
);

function openLink(column: TableColumn, value: string) {
  const target = column.type === "email" ? `mailto:${value}` : value;
  if (column.type === "email" ? EMAIL.test(value) : URL_RE.test(value))
    window.open(target, "_blank", "noopener");
}

/** A value the column's type cannot show: it stays in the CSV and is drawn as raw red text. */
export function misfit(column: TableColumn, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (NUMERIC_TYPES.includes(column.type)) return typeof value !== "number";
  if (column.type === "checkbox") return typeof value !== "boolean";
  if (column.type === "date")
    return (
      typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-][\d:]+)?)?$/.test(value)
    );
  if (column.type === "email") return !EMAIL.test(String(value));
  if (column.type === "url") return !URL_RE.test(String(value));
  return false;
}

export function cellFor(
  column: TableColumn,
  value: unknown,
  onField?: (column: TableColumn, next: PageProperty, previous: PageProperty) => void,
  colors?: GridColors,
  onOpen?: RelationData["onOpen"],
  links?: { table: string } & Pick<LinksData, "onOpenFile" | "onOpenPage">,
): GridCell {
  if (column.type === "relation")
    return relationCell(column, isRelationLinks(value) ? value : [], onOpen);
  if (column.type === "file" || column.type === "page") {
    const { table = "", ...handlers } = links ?? {};
    return linksCell(column, table, value, handlers);
  }
  if (column.type === "formula") {
    // Computed by the daemon (D75): drawn like its format, never edited.
    const cell = cellFor(shownAs(column), value, undefined, colors);
    return { ...cell, allowOverlay: false, readonly: true } as GridCell;
  }
  if (misfit(column, value))
    return {
      kind: GridCellKind.Text,
      data: String(value),
      displayData: String(value),
      allowOverlay: true,
      themeOverride: colors ? { textDark: colors.destructive } : undefined,
    };
  if (CHOICE_TYPES.includes(column.type)) {
    const values = Array.isArray(value)
      ? value.map(String)
      : value === null || value === undefined || value === ""
        ? []
        : [String(value)];
    return tagsCell(column, values, onField && ((n, p) => onField(column, n, p)));
  }
  if (NUMERIC_TYPES.includes(column.type))
    return {
      kind: GridCellKind.Number,
      data: typeof value === "number" ? value : undefined,
      displayData: formatValue(column, value),
      allowOverlay: true,
      contentAlign: "right",
    };
  if (column.type === "checkbox")
    return {
      kind: GridCellKind.Boolean,
      data: value === true,
      allowOverlay: false,
      maxSize: 14,
      contentAlign: "left",
      // Black and white: Glide fills a checked box with textMedium (accentColor when the
      // cell is selected) and outlines an empty one with textMedium.
      themeOverride: colors
        ? {
            textMedium: colors.foreground,
            accentColor: colors.foreground,
            bgCell: colors.background,
          }
        : undefined,
    };
  if (column.type === "url" || column.type === "email") {
    const text = typeof value === "string" ? value : "";
    return {
      kind: GridCellKind.Uri,
      data: text,
      allowOverlay: true,
      hoverEffect: true,
      onClickUri: (args) => {
        args.preventDefault();
        openLink(column, text);
      },
    };
  }
  const shown = formatValue(column, value);
  return {
    kind: GridCellKind.Text,
    allowWrapping: column.wrap === true,
    // A date edits as its ISO text; it reads as "September 15, 2026".
    data: column.type === "date" && typeof value === "string" ? value : shown,
    displayData: shown,
    allowOverlay: true,
  };
}

/** The value an edited cell stands for, in the shape the daemon expects for its column.
 *  Throws with a message the user can act on when the text does not fit the type. */
export function valueOf(
  column: TableColumn,
  cell: EditableGridCell | TagsCell | RelationCell | LinksCell,
): unknown {
  if (cell.kind === GridCellKind.Custom && (cell as LinksCell).data.kind === "graite-links") {
    const { files, pages } = (cell as LinksCell).data;
    return column.type === "file"
      ? files.map((f) => ({ file: f.file, name: f.name }))
      : pages.map((p) => ({ path: p.path, title: p.title }));
  }
  if (cell.kind === GridCellKind.Custom && (cell as RelationCell).data.kind === "graite-relation")
    return (cell as RelationCell).data.links.map((l): RelationLink => ({
      id: l.id,
      label: l.label,
    }));
  if (cell.kind === GridCellKind.Custom) {
    const values = (cell as TagsCell).data.values;
    return column.type === "multi_select" ? values : (values[0] ?? null);
  }
  switch (cell.kind) {
    case GridCellKind.Number:
      return cell.data ?? null;
    case GridCellKind.Boolean:
      return cell.data === true;
    case GridCellKind.Uri:
    case GridCellKind.Text: {
      const text = String(cell.data ?? "").trim();
      if (!text) return null;
      if (NUMERIC_TYPES.includes(column.type)) {
        const n = parseNumber(text);
        if (n === null) throw new Error(`“${text}” is not a number.`);
        return n;
      }
      if (column.type === "date") {
        const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text : parseDateInput(text);
        if (!iso) throw new Error(`“${text}” is not a date. Try 2026-10-01 or “tomorrow”.`);
        return iso;
      }
      if (column.type === "email" && !EMAIL.test(text))
        throw new Error(`“${text}” is not an email address.`);
      if (column.type === "url" && !URL_RE.test(text)) {
        const withScheme = `https://${text}`;
        if (!URL_RE.test(withScheme) || !text.includes("."))
          throw new Error(`“${text}” is not a web address.`);
        return withScheme;
      }
      return text;
    }
    default:
      return null;
  }
}

export interface GridProps {
  columns: TableColumn[];
  total: number;
  row: (index: number) => TableRow | undefined;
  ensure: (first: number, last: number) => void;
  /** Index of each shown column in `TableRow.cells`. */
  cellIndex: number[];
  /** A fixed height (the fence's `height`), or null to fit the rows up to 480px. */
  height: number | null;
  widths: Record<string, number>;
  selection: GridSelection;
  onSelection: (selection: GridSelection) => void;
  onWrite: (ops: RowOp[], optimistic: [string, number, unknown][]) => void;
  onInvalid: (message: string) => void;
  /** Options of a select column were added, renamed, removed or recolored. */
  onField: (column: TableColumn, next: PageProperty, previous: PageProperty) => void;
  /** Rows an AI proposal would change; tinted until the proposal is decided. */
  pendingIds?: Set<string>;
  /** Delete these rows (the Delete key with whole rows selected). */
  onDeleteRows: (rows: number[]) => void;
  /** The "+" after the last column, with where it sits on screen. */
  onAddField: (anchor: DOMRect) => void;
  onResize: (name: string, width: number, done: boolean) => void;
  onMove: (from: number, to: number) => void;
  onHeaderMenu: (column: TableColumn, bounds: Rectangle) => void;
  /** A linked row's pill was clicked. */
  onOpenLink?: (column: TableColumn, link: RelationLink) => void;
  /** The table's vault path (file cells upload into its page's attachments). */
  table?: string;
  /** A file chip was clicked. */
  onOpenFile?: (table: string, file: FileLink) => void;
  /** A page chip was clicked. */
  onOpenPage?: (path: string) => void;
  /** The hover "Open" button on a row's first cell was clicked (D80). */
  onOpenRow?: (row: TableRow) => void;
  /** Files were dropped on a file cell. */
  onDropFiles?: (row: TableRow, column: TableColumn, files: File[]) => void;
}

/** Width of the hover "Open" button drawn in a row's first cell. */
export const OPEN_WIDTH = 52;
/** Whether a click at `x` (from the cell's left edge) hits a cell's "Open" button. */
export function openHit(width: number, x: number): boolean {
  return x >= width - OPEN_WIDTH - 4 && x <= width - 4;
}

export function emptySelection(): GridSelection {
  return { columns: CompactSelection.empty(), rows: CompactSelection.empty() };
}

export function TableGrid(props: GridProps) {
  const { columns, row, cellIndex, onWrite, onInvalid, onField, onOpenLink } = props;
  const { table, onOpenFile, onOpenPage, onDropFiles } = props;
  const links = useMemo(
    () => ({ table: table ?? "", onOpenFile, onOpenPage }),
    [table, onOpenFile, onOpenPage],
  );
  const { theme, colors } = useGridTheme();

  const widthOf = useCallback(
    (c: TableColumn) => props.widths[c.name] ?? c.width ?? (c.type === "checkbox" ? 100 : 180),
    [props.widths],
  );
  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map((c) => ({
        id: c.name,
        title: c.name,
        width: widthOf(c),
        icon: `type-${c.type}`,
        hasMenu: true,
      })),
    [columns, widthOf],
  );

  // Rows grow to fit the text of columns that wrap (up to MAX_LINES lines).
  const wrapping = useMemo(
    () => columns.map((c, i) => [c, i] as const).filter(([c]) => c.wrap),
    [columns],
  );
  const rowHeight = useMemo(() => {
    if (!wrapping.length) return ROW_HEIGHT;
    const font = `13px ${theme.fontFamily ?? "sans-serif"}`;
    return (index: number) => {
      const record = row(index);
      if (!record) return ROW_HEIGHT;
      let lines = 1;
      for (const [column, col] of wrapping) {
        const text = formatValue(column, record.cells[cellIndex[col]!]);
        if (text) lines = Math.max(lines, lineCount(text, widthOf(column) - 17, font));
      }
      return Math.max(ROW_HEIGHT, Math.min(lines, MAX_LINES) * LINE_HEIGHT + 16);
    };
  }, [wrapping, row, cellIndex, widthOf, theme.fontFamily]);
  const height = useMemo(() => {
    if (props.height) return props.height;
    let rows = 0;
    for (let i = 0; i < Math.max(props.total, 1) && rows < MAX_HEIGHT; i++)
      rows += typeof rowHeight === "number" ? rowHeight : rowHeight(i);
    return Math.min(MAX_HEIGHT, HEADER_HEIGHT + rows + 2 + SCROLLBAR_ROOM);
  }, [props.height, props.total, rowHeight]);

  // The "+" for a new field sits right after the last column (Glide's `rightElement` would
  // put it at the far right of the grid); when the columns are wider than the block it stays
  // pinned to the right edge of the header, so it never scrolls out of reach.
  const editorRef = useRef<DataEditorRef>(null);
  const hoveredRow = useRef(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const [plus, setPlus] = useState<{ left: number; pinned: boolean } | null>(null);
  const placePlus = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const bounds = columns.length ? editorRef.current?.getBounds(columns.length - 1, 0) : undefined;
    const left = bounds
      ? bounds.x + bounds.width - box.getBoundingClientRect().x
      : MARKER_WIDTH + gridColumns.reduce((sum, c) => sum + ("width" in c ? c.width : 0), 0);
    const edge = box.clientWidth - PLUS_WIDTH;
    setPlus(left <= edge ? { left, pinned: false } : { left: edge, pinned: true });
  }, [columns.length, gridColumns]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(placePlus);
    return () => cancelAnimationFrame(frame);
  }, [placePlus, props.total]);

  const pendingTint = useMemo(() => mix("#c37932", 0.12, colors.background), [colors.background]);
  const getRowThemeOverride = useCallback(
    (index: number) => {
      const id = row(index)?.id;
      return id && props.pendingIds?.has(id) ? { bgCell: pendingTint } : undefined;
    },
    [row, props.pendingIds, pendingTint],
  );

  const getCellContent = useCallback(
    ([col, index]: Item): GridCell => {
      const record = row(index);
      const column = columns[col];
      if (!record || !column) return { kind: GridCellKind.Loading, allowOverlay: false };
      return cellFor(column, record.cells[cellIndex[col]!], onField, colors, onOpenLink, links);
    },
    [row, columns, cellIndex, onField, colors, onOpenLink, links],
  );

  const onCellsEdited = useCallback(
    (items: readonly EditListItem[]) => {
      const byRow = new Map<string, RowOp>();
      const optimistic: [string, number, unknown][] = [];
      for (const { location, value } of items) {
        const [col, index] = location;
        const record = row(index);
        const column = columns[col];
        if (!record || !column || column.type === "formula") continue;
        const cell = cellIndex[col]!;
        let next: unknown;
        try {
          next = valueOf(column, value);
        } catch (e) {
          onInvalid((e as Error).message);
          continue;
        }
        const op = byRow.get(record.id) ?? {
          op: "update" as const,
          id: record.id,
          values: {},
          base: {},
        };
        op.values = { ...op.values, [column.name]: next };
        op.base = { ...op.base, [column.name]: record.cells[cell] ?? null };
        byRow.set(record.id, op);
        optimistic.push([record.id, cell, next]);
      }
      if (byRow.size) onWrite([...byRow.values()], optimistic);
      return true;
    },
    [row, columns, cellIndex, onWrite, onInvalid],
  );

  return (
    <div className="table-grid" ref={boxRef}>
      <DataEditor
        ref={editorRef}
        columns={gridColumns}
        rows={props.total}
        getCellContent={getCellContent}
        getRowThemeOverride={getRowThemeOverride}
        customRenderers={RENDERERS}
        headerIcons={HEADER_ICONS}
        onCellsEdited={onCellsEdited}
        onCellEdited={(cell, value) => onCellsEdited([{ location: cell, value }])}
        // The first cell of the row under the mouse shows "Open" at its right edge.
        drawCell={(args, draw) => {
          draw();
          if (!props.onOpenRow || args.col !== 0 || args.row !== hoveredRow.current) return;
          const { ctx, rect, theme: t } = args;
          const x = rect.x + rect.width - OPEN_WIDTH - 4;
          const y = rect.y + (rect.height - 20) / 2;
          ctx.save();
          ctx.beginPath();
          ctx.roundRect?.(x, y, OPEN_WIDTH, 20, 4);
          ctx.fillStyle = t.bgCell;
          ctx.fill();
          ctx.strokeStyle = t.borderColor;
          ctx.stroke();
          ctx.fillStyle = t.textMedium;
          ctx.font = `11px ${t.fontFamily}`;
          ctx.textBaseline = "middle";
          ctx.fillText("⤢ Open", x + 7, y + 10);
          ctx.restore();
        }}
        onItemHovered={(args) => {
          // Glide animates hover only for cells with a hover effect, so the row under the
          // mouse is tracked here and its first cell redrawn with or without "Open".
          const next = args.kind === "cell" ? args.location[1] : -1;
          const before = hoveredRow.current;
          if (next === before) return;
          hoveredRow.current = next;
          const damage = [before, next]
            .filter((r) => r >= 0)
            .map((r) => ({ cell: [0, r] as Item }));
          if (damage.length) editorRef.current?.updateCells(damage);
        }}
        onCellClicked={(cell, event) => {
          if (!props.onOpenRow || cell[0] !== 0) return;
          if (!openHit(event.bounds.width, event.localEventX)) return;
          const record = row(cell[1]);
          if (!record) return;
          event.preventDefault();
          props.onOpenRow(record);
        }}
        onVisibleRegionChanged={(range) => {
          props.ensure(range.y, range.y + range.height);
          placePlus();
        }}
        getCellsForSelection
        onPaste
        // Glide reads pasted numbers with parseFloat, which turns "12,50" into 12.
        coercePasteValue={(text, cell) => {
          if (cell.kind !== GridCellKind.Number) return undefined;
          const n = parseNumber(text);
          return n === null ? undefined : { ...cell, data: n };
        }}
        width="100%"
        height={height}
        rowHeight={rowHeight}
        headerHeight={HEADER_HEIGHT}
        theme={theme}
        smoothScrollX
        smoothScrollY
        // Rounded-square checkboxes that show on hover and stay while a row is selected;
        // clicking one adds its row to the selection instead of replacing it.
        rowMarkers={{ kind: "checkbox", checkboxStyle: "square", width: MARKER_WIDTH }}
        rowSelectionMode="multi"
        gridSelection={props.selection}
        onGridSelectionChange={props.onSelection}
        rangeSelect="multi-rect"
        columnSelect="none"
        onDelete={(selection) => {
          const rows = selection.rows.toArray();
          if (!rows.length) return true; // clear the selected cells, as usual
          props.onDeleteRows(rows);
          return false;
        }}
        onColumnResize={(column, width) => {
          props.onResize(String(column.id), width, false);
          placePlus();
        }}
        onColumnResizeEnd={(column, width) => props.onResize(String(column.id), width, true)}
        onColumnMoved={props.onMove}
        onHeaderMenuClick={(col, bounds) => {
          const column = columns[col];
          if (column) props.onHeaderMenu(column, bounds);
        }}
        // A click on the field's name opens its menu too (a drag still moves the column).
        onHeaderClicked={(col, event) => {
          const column = columns[col];
          if (!column || event.isEdge) return;
          event.preventDefault();
          props.onHeaderMenu(column, event.bounds);
        }}
        // Files dropped on a file cell are attached to that row (D76).
        onDragOverCell={(cell, transfer) => {
          if (columns[cell[0]]?.type === "file" && transfer?.types.includes("Files"))
            transfer.dropEffect = "copy";
        }}
        onDrop={([col, index], transfer) => {
          const column = columns[col];
          const record = row(index);
          const files = [...(transfer?.files ?? [])];
          if (column?.type === "file" && record && files.length)
            onDropFiles?.(record, column, files);
        }}
        preventDiagonalScrolling
        verticalBorder
      />
      {plus !== null && (
        <button
          type="button"
          className={`table-add-field ${plus.pinned ? "pinned" : ""}`}
          aria-label="New field"
          title="New field"
          style={{ left: plus.left, height: HEADER_HEIGHT, width: PLUS_WIDTH }}
          onClick={(e) => props.onAddField(e.currentTarget.getBoundingClientRect())}
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}
