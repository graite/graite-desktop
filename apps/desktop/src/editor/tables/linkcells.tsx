import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileText, Loader2, Paperclip, Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  GridCellKind,
  roundedRect,
  type CustomCell,
  type CustomRenderer,
  type ProvideEditorComponent,
} from "@glideapps/glide-data-grid";
import { pages, type TreeNode } from "@/lib/api";
import { tables, type FileLink, type PageLink, type TableColumn } from "@/lib/tables";
import { allPages, type FlatPage } from "../tree-utils";
import { mix, TAG_HEX } from "./cells";
import { shortName } from "./columns";

/**
 * File and page cells (D76): attachments and linked pages as chips. A click on a chip
 * opens the file in the system's app or navigates to the page; the cell editor adds and
 * removes them (files by picking or dropping, pages from a search).
 */
export interface LinksData {
  kind: "graite-links";
  column: TableColumn;
  /** The table's vault path: files live in its page's attachments. */
  table: string;
  files: FileLink[];
  pages: PageLink[];
  onOpenFile?: (table: string, file: FileLink) => void;
  onOpenPage?: (path: string) => void;
}
export type LinksCell = CustomCell<LinksData>;

export function linksCell(
  column: TableColumn,
  table: string,
  value: unknown,
  handlers: Pick<LinksData, "onOpenFile" | "onOpenPage"> = {},
): LinksCell {
  const items = Array.isArray(value) ? value : [];
  const files = column.type === "file" ? (items as FileLink[]) : [];
  const linked = column.type === "page" ? (items as PageLink[]) : [];
  const names = column.type === "file" ? files.map((f) => f.name) : linked.map((p) => p.title);
  return {
    kind: GridCellKind.Custom,
    data: { kind: "graite-links", column, table, files, pages: linked, ...handlers },
    copyData: names.join(", "),
    allowOverlay: true,
    cursor: names.length ? "pointer" : undefined,
  };
}

const PILL_HEIGHT = 20;
const GAP = 4;
const PAD = 7;
const ICON = 11;
const ICON_GAP = 4;
// lucide's paperclip and file-text icons (24px grid), drawn on the canvas before each label.
const PAPERCLIP = [
  "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
];
const PAGE = [
  "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
  "M14 2v4a2 2 0 0 0 2 2h4",
  "M10 9H8",
  "M16 13H8",
  "M16 17H8",
];
const icons = new Map<string[], Path2D[]>();

function drawIcon(
  ctx: CanvasRenderingContext2D,
  paths: string[],
  x: number,
  y: number,
  color: string,
) {
  let drawn = icons.get(paths);
  if (!drawn) {
    drawn = paths.map((d) => new Path2D(d));
    icons.set(paths, drawn);
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(ICON / 24, ICON / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of drawn) ctx.stroke(path);
  ctx.restore();
}

interface Chip {
  index: number;
  text: string;
  emoji: string | null;
  broken: boolean;
  x: number;
  width: number;
}

function chipsOf(data: LinksData): Omit<Chip, "x" | "width">[] {
  if (data.column.type === "file")
    return data.files.map((f, index) => ({
      index,
      text: shortName(f.name),
      emoji: null,
      broken: false,
    }));
  return data.pages.map((p, index) => {
    const emoji = p.icon && !p.icon.startsWith("lucide:") ? p.icon : null;
    return {
      index,
      text: p.broken ? p.title || "Missing page" : p.title || "Untitled",
      emoji,
      broken: p.broken === true,
    };
  });
}

/** Where each chip goes in a cell `width` wide, and how many did not fit. */
function layout(
  ctx: CanvasRenderingContext2D,
  data: LinksData,
  width: number,
  padding: number,
): { chips: Chip[]; more: number } {
  const all = chipsOf(data);
  const chips: Chip[] = [];
  const right = width - padding;
  let x = padding;
  for (let i = 0; i < all.length; i++) {
    const chip = all[i]!;
    const w = ctx.measureText(chip.text).width + PAD * 2 + ICON + ICON_GAP;
    if (x + w > right && i > 0) return { chips, more: all.length - i };
    chips.push({ ...chip, x, width: Math.min(w, right - x) });
    x += w + GAP;
  }
  return { chips, more: 0 };
}

let measurer: CanvasRenderingContext2D | null | undefined;

export const linksRenderer: CustomRenderer<LinksCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is LinksCell => (cell.data as LinksData).kind === "graite-links",
  needsHover: true,
  needsHoverPosition: true,
  draw: ({ ctx, rect, theme, hoverX }, cell) => {
    const file = cell.data.column.type === "file";
    ctx.save();
    ctx.font = `12px ${theme.fontFamily}`;
    ctx.textBaseline = "middle";
    const { chips, more } = layout(ctx, cell.data, rect.width, theme.cellHorizontalPadding);
    const y = rect.y + (rect.height - PILL_HEIGHT) / 2;
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    for (const chip of chips) {
      const x = rect.x + chip.x;
      // Files are gray, pages brown (the page palette), a page that is gone red.
      const tint = chip.broken ? TAG_HEX.red! : file ? TAG_HEX.gray! : TAG_HEX.brown!;
      const hovered =
        !chip.broken && hoverX !== undefined && hoverX >= chip.x && hoverX <= chip.x + chip.width;
      ctx.beginPath();
      roundedRect(ctx, x, y, chip.width, PILL_HEIGHT, 4);
      ctx.fillStyle = mix(tint, hovered ? 0.24 : 0.12, theme.bgCell);
      ctx.fill();
      const ink = mix(tint, 0.85, theme.textDark);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, chip.width - 4, PILL_HEIGHT);
      ctx.clip();
      if (chip.emoji) {
        ctx.font = `11px ${theme.fontFamily}`;
        ctx.fillText(chip.emoji, x + PAD - 2, y + PILL_HEIGHT / 2 + 1);
        ctx.font = `12px ${theme.fontFamily}`;
      } else drawIcon(ctx, file ? PAPERCLIP : PAGE, x + PAD - 1, y + (PILL_HEIGHT - ICON) / 2, ink);
      const textX = x + PAD - 1 + ICON + ICON_GAP;
      ctx.fillStyle = ink;
      ctx.fillText(chip.text, textX, y + PILL_HEIGHT / 2);
      if (chip.broken || hovered) {
        const w = Math.min(ctx.measureText(chip.text).width, x + chip.width - PAD - textX);
        ctx.fillRect(textX, y + PILL_HEIGHT / 2 + (chip.broken ? 0 : 6), w, 1);
      }
      ctx.restore();
    }
    if (more) {
      const last = chips[chips.length - 1];
      ctx.fillStyle = theme.textLight;
      ctx.fillText(
        `+${more}`,
        rect.x + (last ? last.x + last.width + GAP : theme.cellHorizontalPadding),
        rect.y + rect.height / 2,
      );
    }
    ctx.restore();
    return true;
  },
  onClick: (args) => {
    const { cell, posX, bounds, theme } = args;
    const data = cell.data;
    measurer ??= document.createElement("canvas").getContext("2d");
    if (!measurer) return undefined;
    measurer.font = `12px ${theme.fontFamily}`;
    const hit = layout(measurer, data, bounds.width, theme.cellHorizontalPadding).chips.find(
      (c) => posX >= c.x && posX <= c.x + c.width,
    );
    if (!hit || hit.broken) return undefined;
    if (data.column.type === "file" && data.onOpenFile) {
      args.preventDefault();
      data.onOpenFile(data.table, data.files[hit.index]!);
    } else if (data.column.type === "page" && data.onOpenPage) {
      args.preventDefault();
      data.onOpenPage(data.pages[hit.index]!.path);
    }
    return undefined;
  },
  provideEditor: () => ({
    editor: LinksEditor,
    disablePadding: true,
    styleOverride: { border: "none", boxShadow: "none", background: "transparent", padding: 0 },
  }),
  onPaste: (text, data) => {
    // Pasted `[[target|label]]` links (copied from another cell or the CSV).
    const found = [...text.matchAll(/\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g)].map((m) => ({
      target: m[1]!.trim(),
      label: (m[2] ?? "").trim(),
    }));
    return data.column.type === "file"
      ? { ...data, files: found.map((f) => ({ file: f.target, name: f.label || f.target })) }
      : { ...data, pages: found.map((p) => ({ path: p.target, title: p.label || p.target })) };
  },
  onDelete: (cell) => ({ ...cell, data: { ...cell.data, files: [], pages: [] } }),
};

/** Upload `files` into the table's page attachments; the stored `{file, name}` of each. */
export async function uploadAll(table: string, files: File[]): Promise<FileLink[]> {
  const out: FileLink[] = [];
  for (const file of files) {
    try {
      out.push(await tables.uploadFile(table, file));
    } catch (e) {
      toast.error(`${file.name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** The files of a file cell: open or remove each, add more by picking or dropping. */
export function FileList({
  table,
  files,
  single,
  onChange,
  onOpen,
}: {
  table: string;
  files: FileLink[];
  single: boolean;
  onChange: (files: FileLink[]) => void;
  onOpen?: (file: FileLink) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const add = async (list: File[]) => {
    if (!list.length) return;
    setBusy(true);
    const added = await uploadAll(table, single ? list.slice(0, 1) : list);
    setBusy(false);
    if (added.length) onChange(single ? added.slice(0, 1) : [...files, ...added]);
  };
  return (
    <div
      className={`table-files${over ? " over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void add([...e.dataTransfer.files]);
      }}
    >
      {files.map((f) => (
        <span key={f.file} className="table-file-chip" title={f.name}>
          <button type="button" className="table-file-open" onClick={() => onOpen?.(f)}>
            <Paperclip size={12} />
            {shortName(f.name)}
          </button>
          <button
            type="button"
            aria-label={`Remove ${f.name}`}
            title="Remove from this cell (the file stays in the page's attachments)"
            onClick={() => onChange(files.filter((x) => x.file !== f.file))}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <button
        type="button"
        className="table-file-add"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        {busy ? "Uploading…" : files.length ? "Add file" : "Add a file or drop it here"}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        multiple={!single}
        onChange={(e) => {
          void add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

let treeCache: Promise<TreeNode[]> | null = null;

/** Search the vault's pages and pick one or several. */
export function PageLinkPicker({
  selected,
  single,
  onChange,
}: {
  selected: PageLink[];
  single: boolean;
  onChange: (pages: PageLink[], done: boolean) => void;
}) {
  const [all, setAll] = useState<FlatPage[] | null>(null);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    // A fresh tree each time a picker opens; pickers opened together share it.
    treeCache = pages.tree();
    void treeCache
      .then((tree) => live && setAll(allPages(tree)))
      .catch(() => live && setAll([]))
      .finally(() => (treeCache = null));
    return () => {
      live = false;
    };
  }, []);

  const found = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (all ?? [])
      .filter((p) => !q || p.title.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      .slice(0, 40);
  }, [all, search]);
  useEffect(() => setActive(0), [search]);

  const chosen = useMemo(() => new Set(selected.map((p) => p.path)), [selected]);
  const pick = (page: FlatPage) => {
    const link: PageLink = { path: page.path, title: page.title, icon: page.icon };
    if (single) {
      onChange(chosen.has(page.path) ? [] : [link], true);
      return;
    }
    onChange(
      chosen.has(page.path) ? selected.filter((p) => p.path !== page.path) : [...selected, link],
      false,
    );
    input.current?.focus();
  };

  return (
    <div className="table-relation-picker">
      {selected.length > 0 && (
        <div className="table-relation-selected">
          {selected.map((p) => (
            <span key={p.path} className={`table-relation-pill${p.broken ? " broken" : ""}`}>
              {p.title || "Untitled"}
              <button
                type="button"
                aria-label={`Remove ${p.title || "page"}`}
                onClick={() =>
                  onChange(
                    selected.filter((x) => x.path !== p.path),
                    false,
                  )
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={input}
        autoFocus
        className="table-relation-search"
        placeholder="Search pages…"
        aria-label="Search pages to link"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, found.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && found[active]) pick(found[active]!);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <div className="table-relation-results" role="listbox">
        {all === null && <div className="table-relation-empty">Loading…</div>}
        {all !== null && !found.length && (
          <div className="table-relation-empty">No pages found</div>
        )}
        {found.map((p, i) => (
          <button
            key={p.path}
            type="button"
            role="option"
            aria-selected={chosen.has(p.path)}
            className={`table-relation-option${i === active ? " active" : ""}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(p)}
          >
            <span className="table-page-icon">
              {p.icon && !p.icon.startsWith("lucide:") ? p.icon : <FileText size={13} />}
            </span>
            <span className="table-relation-label">{p.title || "Untitled"}</span>
            {p.breadcrumb && <span className="table-relation-secondary">{p.breadcrumb}</span>}
            {chosen.has(p.path) && <Check size={13} className="ml-auto" />}
          </button>
        ))}
      </div>
    </div>
  );
}

const LinksEditor: ProvideEditorComponent<LinksCell> = ({ value, onChange, onFinishedEditing }) => {
  const data = value.data;
  const single = data.column.cardinality === "one";
  const cell = (next: Partial<LinksData>): LinksCell => {
    const merged = { ...data, ...next };
    const names =
      merged.column.type === "file"
        ? merged.files.map((f) => f.name)
        : merged.pages.map((p) => p.title);
    return { ...value, data: merged, copyData: names.join(", ") };
  };
  if (data.column.type === "file")
    return (
      <div className="table-tags-editor table-files-editor">
        <FileList
          table={data.table}
          files={data.files}
          single={single}
          onChange={(files) => onChange(cell({ files }))}
          onOpen={(f) => data.onOpenFile?.(data.table, f)}
        />
      </div>
    );
  return (
    <div className="table-tags-editor">
      <PageLinkPicker
        selected={data.pages}
        single={single}
        onChange={(next, done) =>
          done ? onFinishedEditing(cell({ pages: next })) : onChange(cell({ pages: next }))
        }
      />
    </div>
  );
};
