import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import {
  GridCellKind,
  roundedRect,
  type CustomCell,
  type CustomRenderer,
  type ProvideEditorComponent,
} from "@glideapps/glide-data-grid";
import { tables, type RelationLink, type TableColumn } from "@/lib/tables";
import { mix, TAG_HEX } from "./cells";

/** A relation cell (D71): the linked rows as pills; a click on one opens it. */
export interface RelationData {
  kind: "graite-relation";
  column: TableColumn;
  links: RelationLink[];
  onOpen?: (column: TableColumn, link: RelationLink) => void;
}
export type RelationCell = CustomCell<RelationData>;

export function relationCell(
  column: TableColumn,
  links: RelationLink[],
  onOpen?: RelationData["onOpen"],
): RelationCell {
  return {
    kind: GridCellKind.Custom,
    data: { kind: "graite-relation", column, links, onOpen },
    copyData: links.map((l) => l.label).join(", "),
    allowOverlay: !!column.target,
    // Pills are links: a hand over the cell says a click opens the row.
    cursor: links.some((l) => !l.broken) && onOpen ? "pointer" : undefined,
  };
}

const PILL_HEIGHT = 20;
const GAP = 4;
const PAD = 7;
const MISSING = "Missing row";
// Room for the link icon drawn before each label.
const ICON = 11;
const ICON_GAP = 4;
// lucide's link-2 icon (24px grid), drawn on the canvas next to each label.
const LINK_ICON = ["M9 17H7A5 5 0 0 1 7 7h2", "M15 7h2a5 5 0 1 1 0 10h-2", "M8 12h8"];
let linkPaths: Path2D[] | null = null;

function drawLinkIcon(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  linkPaths ??= LINK_ICON.map((d) => new Path2D(d));
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(ICON / 24, ICON / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of linkPaths) ctx.stroke(path);
  ctx.restore();
}

let measurer: CanvasRenderingContext2D | null | undefined;

interface Pill {
  link: RelationLink;
  x: number;
  width: number;
}

/** Where each pill goes in a cell `width` wide (x from the cell's left edge), and how many
 *  links did not fit. The same layout serves drawing and clicking. */
function layout(
  ctx: CanvasRenderingContext2D,
  links: RelationLink[],
  width: number,
  padding: number,
): { pills: Pill[]; more: number } {
  const pills: Pill[] = [];
  const right = width - padding;
  let x = padding;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    const text = link.broken ? link.label || MISSING : link.label || "Untitled";
    const w = ctx.measureText(text).width + PAD * 2 + ICON + ICON_GAP;
    if (x + w > right && i > 0) return { pills, more: links.length - i };
    pills.push({ link, x, width: Math.min(w, right - x) });
    x += w + GAP;
  }
  return { pills, more: 0 };
}

export const relationRenderer: CustomRenderer<RelationCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is RelationCell => (cell.data as RelationData).kind === "graite-relation",
  needsHover: true,
  needsHoverPosition: true,
  draw: ({ ctx, rect, theme, hoverX }, cell) => {
    const { links } = cell.data;
    ctx.save();
    ctx.font = `12px ${theme.fontFamily}`;
    ctx.textBaseline = "middle";
    const { pills, more } = layout(ctx, links, rect.width, theme.cellHorizontalPadding);
    const y = rect.y + (rect.height - PILL_HEIGHT) / 2;
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    for (const pill of pills) {
      const x = rect.x + pill.x;
      const broken = pill.link.broken === true;
      // Links are blue with a link icon, unlike the gray and colored select pills; a link
      // to a row that is gone is red and struck through.
      const tint = broken ? TAG_HEX.red! : TAG_HEX.blue!;
      const hovered =
        !broken && hoverX !== undefined && hoverX >= pill.x && hoverX <= pill.x + pill.width;
      ctx.beginPath();
      roundedRect(ctx, x, y, pill.width, PILL_HEIGHT, 4);
      ctx.fillStyle = mix(tint, hovered ? 0.22 : 0.1, theme.bgCell);
      ctx.fill();
      const ink = mix(tint, 0.85, theme.textDark);
      const text = broken ? pill.link.label || MISSING : pill.link.label || "Untitled";
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, pill.width - 4, PILL_HEIGHT);
      ctx.clip();
      drawLinkIcon(ctx, x + PAD - 1, y + (PILL_HEIGHT - ICON) / 2, ink);
      const textX = x + PAD - 1 + ICON + ICON_GAP;
      ctx.fillStyle = ink;
      ctx.fillText(text, textX, y + PILL_HEIGHT / 2);
      if (broken || hovered) {
        // Struck through when broken; underlined, like a link, under the pointer.
        const w = Math.min(ctx.measureText(text).width, x + pill.width - PAD - textX);
        ctx.fillRect(textX, y + PILL_HEIGHT / 2 + (broken ? 0 : 6), w, 1);
      }
      ctx.restore();
    }
    if (more) {
      const last = pills[pills.length - 1];
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
    const { links, onOpen, column } = cell.data;
    if (!onOpen) return undefined;
    measurer ??= document.createElement("canvas").getContext("2d");
    if (!measurer) return undefined;
    measurer.font = `12px ${theme.fontFamily}`;
    const hit = layout(measurer, links, bounds.width, theme.cellHorizontalPadding).pills.find(
      (p) => posX >= p.x && posX <= p.x + p.width,
    );
    if (hit && !hit.link.broken) {
      args.preventDefault();
      onOpen(column, hit.link);
    }
    return undefined;
  },
  provideEditor: () => ({
    editor: RelationEditor,
    disablePadding: true,
    styleOverride: { border: "none", boxShadow: "none", background: "transparent", padding: 0 },
  }),
  onPaste: (text, data) => ({
    ...data,
    // Pasted link text or ids; labels come back from the daemon after the write.
    links: [...text.matchAll(/\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g)].map((m) => ({
      id: m[1]!.trim(),
      label: (m[2] ?? "").trim(),
    })),
  }),
  onDelete: (cell) => ({ ...cell, data: { ...cell.data, links: [] } }),
};

interface Candidate {
  id: string;
  label: string;
  secondary: string;
}

/** The searchable picker of rows in the target table. */
export function RelationPicker({
  target,
  selected,
  single,
  onChange,
}: {
  /** The table to pick from. */
  target: string;
  selected: RelationLink[];
  /** At most one link: picking replaces it and closes. */
  single: boolean;
  onChange: (links: RelationLink[], done: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<Candidate[]>([]);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      tables
        .rows(target, { search: search.trim() || undefined, limit: 30 })
        .then((page) => {
          if (!live) return;
          const at = (name: string | null | undefined) => (name ? page.visible.indexOf(name) : -1);
          const label = at(page.label_column);
          const secondary = at(page.secondary_column);
          const text = (value: unknown) =>
            value === null || value === undefined
              ? ""
              : Array.isArray(value)
                ? value.join(", ")
                : String(value);
          setFound(
            page.rows.map((row) => ({
              id: row.id,
              label: label >= 0 ? text(row.cells[label]) : "",
              secondary: secondary >= 0 ? text(row.cells[secondary]) : "",
            })),
          );
          setActive(0);
          setError("");
        })
        .catch((e: Error) => live && setError(e.message));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [target, search]);

  const chosen = useMemo(() => new Set(selected.map((l) => l.id)), [selected]);
  const pick = (c: Candidate) => {
    if (single) {
      onChange(chosen.has(c.id) ? [] : [{ id: c.id, label: c.label }], true);
      return;
    }
    onChange(
      chosen.has(c.id)
        ? selected.filter((l) => l.id !== c.id)
        : [...selected, { id: c.id, label: c.label, secondary: c.secondary || null }],
      false,
    );
    input.current?.focus();
  };

  return (
    <div className="table-relation-picker">
      {selected.length > 0 && (
        <div className="table-relation-selected">
          {selected.map((link) => (
            <span key={link.id} className={`table-relation-pill${link.broken ? " broken" : ""}`}>
              {link.broken ? link.label || MISSING : link.label || "Untitled"}
              <button
                type="button"
                aria-label={`Remove ${link.label || "link"}`}
                onClick={() =>
                  onChange(
                    selected.filter((l) => l.id !== link.id),
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
        placeholder="Search rows…"
        aria-label="Search rows to link"
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
        {error && <div className="table-relation-empty">{error}</div>}
        {!error && !found.length && <div className="table-relation-empty">No rows found</div>}
        {found.map((c, i) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={chosen.has(c.id)}
            className={`table-relation-option${i === active ? " active" : ""}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(c)}
          >
            <span className="table-relation-label">{c.label || "Untitled"}</span>
            {c.secondary && <span className="table-relation-secondary">{c.secondary}</span>}
            {chosen.has(c.id) && <Check size={13} className="ml-auto" />}
          </button>
        ))}
      </div>
    </div>
  );
}

const RelationEditor: ProvideEditorComponent<RelationCell> = ({
  value,
  onChange,
  onFinishedEditing,
}) => {
  const { column, links } = value.data;
  if (!column.target) return null;
  const set = (next: RelationLink[], done: boolean) => {
    const cell = {
      ...value,
      data: { ...value.data, links: next },
      copyData: next.map((l) => l.label).join(", "),
    };
    if (done) onFinishedEditing(cell);
    else onChange(cell);
  };
  return (
    <div className="table-tags-editor">
      <RelationPicker
        target={column.target}
        selected={links}
        single={column.cardinality === "one" && !column.reverse}
        onChange={set}
      />
    </div>
  );
};
