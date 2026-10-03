import { useState } from "react";
import {
  GridCellKind,
  roundedRect,
  type CustomCell,
  type CustomRenderer,
  type ProvideEditorComponent,
} from "@glideapps/glide-data-grid";
import { OptionList } from "@/pages/PropertySelect";
import type { PageProperty } from "@/lib/workspace";
import type { TableColumn } from "@/lib/tables";
import { asProperty } from "./columns";

/** The page-property palette (`.property-tag[data-color]` in pages/pages.css). */
export const TAG_HEX: Record<string, string> = {
  default: "#777777",
  gray: "#808080",
  brown: "#986f50",
  orange: "#c37932",
  yellow: "#a78b24",
  green: "#3e9470",
  blue: "#4285b6",
  purple: "#8a61ad",
  pink: "#b56394",
  red: "#bf625a",
};

type Rgb = [number, number, number];

export function parseColor(color: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const parts = /rgba?\(([^)]+)\)/i
    .exec(color)?.[1]
    ?.split(",")
    .map((p) => parseFloat(p));
  return parts && parts.length >= 3 ? [parts[0]!, parts[1]!, parts[2]!] : [128, 128, 128];
}

/** `color-mix(in srgb, a p%, b)`, as the page pills are painted. */
export function mix(a: string, share: number, b: string): string {
  const x = parseColor(a);
  const y = parseColor(b);
  const c = x.map((v, i) => Math.round(v * share + y[i]! * (1 - share)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export interface TagsData {
  kind: "graite-tags";
  column: TableColumn;
  values: string[];
  /** Options were added, renamed, removed or recolored in the editor. */
  onField?: (next: PageProperty, previous: PageProperty) => void;
}
export type TagsCell = CustomCell<TagsData>;

export function tagsCell(
  column: TableColumn,
  values: string[],
  onField?: TagsData["onField"],
): TagsCell {
  return {
    kind: GridCellKind.Custom,
    data: { kind: "graite-tags", column, values, onField },
    copyData: values.join("; "),
    allowOverlay: true,
  };
}

const PILL_HEIGHT = 18;
const GAP = 4;

const TagsEditor: ProvideEditorComponent<TagsCell> = ({ value, onChange, onFinishedEditing }) => {
  const { column, values, onField } = value.data;
  const [field, setField] = useState(() => asProperty(column, values));
  const multi = column.type === "multi_select";
  const set = (next: string[], done: boolean) => {
    const cell = { ...value, data: { ...value.data, values: next }, copyData: next.join("; ") };
    if (done) onFinishedEditing(cell);
    else onChange(cell);
  };
  const choose = (option: string) =>
    multi
      ? set(
          values.includes(option) ? values.filter((v) => v !== option) : [...values, option],
          false,
        )
      : set(values.includes(option) ? [] : [option], true);
  return (
    <div className="property-select-menu table-tags-editor">
      <OptionList
        field={field}
        selected={values}
        onChoose={choose}
        onCreate={(option) => {
          const next = { ...field, options: [...field.options, option] };
          onField?.(next, field);
          setField(next);
          choose(option);
        }}
        onFieldChange={(next) => {
          onField?.(next, field);
          // A renamed or deleted option rewrites rows: close, the table reloads.
          if (next.options.join("\n") !== field.options.join("\n")) onFinishedEditing(undefined);
          else setField(next);
        }}
      />
    </div>
  );
};

/** Select, multi-select and status cells: page-style pills, status with a colored dot. */
export const tagsRenderer: CustomRenderer<TagsCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is TagsCell => (cell.data as TagsData).kind === "graite-tags",
  draw: ({ ctx, rect, theme }, cell) => {
    const { column, values } = cell.data;
    const status = column.type === "status";
    ctx.save();
    ctx.font = `11px ${theme.fontFamily}`;
    ctx.textBaseline = "middle";
    const y = rect.y + (rect.height - PILL_HEIGHT) / 2;
    const right = rect.x + rect.width - theme.cellHorizontalPadding;
    let x = rect.x + theme.cellHorizontalPadding;
    for (let i = 0; i < values.length; i++) {
      const option = values[i]!;
      const tag = TAG_HEX[column.colors?.[option] ?? "default"] ?? TAG_HEX.default!;
      const textWidth = ctx.measureText(option).width;
      const width = textWidth + 12 + (status ? 11 : 0);
      const more = values.length - i;
      if (x + width > right && i > 0) {
        ctx.fillStyle = theme.textLight;
        ctx.fillText(`+${more}`, x, y + PILL_HEIGHT / 2);
        break;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, right - rect.x, rect.height);
      ctx.clip();
      ctx.beginPath();
      roundedRect(ctx, x, y, width, PILL_HEIGHT, 4);
      ctx.fillStyle = mix(tag, 0.22, theme.bgCell);
      ctx.fill();
      let textX = x + 6;
      if (status) {
        ctx.beginPath();
        ctx.arc(x + 9, y + PILL_HEIGHT / 2, 3, 0, Math.PI * 2);
        ctx.fillStyle = tag;
        ctx.fill();
        textX += 11;
      }
      ctx.fillStyle = mix(tag, 0.7, theme.textDark);
      ctx.fillText(option, textX, y + PILL_HEIGHT / 2);
      ctx.restore();
      x += width + GAP;
    }
    ctx.restore();
    return true;
  },
  // Our editor draws its own light border; Glide's would add a dark ring around it.
  provideEditor: () => ({
    editor: TagsEditor,
    disablePadding: true,
    styleOverride: { border: "none", boxShadow: "none", background: "transparent", padding: 0 },
  }),
  onPaste: (text, data) => ({
    ...data,
    values: text
      .split(/[;,]/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, data.column.type === "multi_select" ? undefined : 1),
  }),
};
