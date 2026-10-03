import { Check, ChevronDown } from "lucide-react";
import type { TableColumn, TableInfo } from "@/lib/tables";
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
import { TypeIcon } from "../tables/columns";

export const BUCKETS = [
  ["", "Exact date"],
  ["day", "By day"],
  ["week", "By week"],
  ["month", "By month"],
  ["quarter", "By quarter"],
  ["year", "By year"],
] as const;

/** How a field reads in the builder: `month(date)` -> "date by month", `owner.city` -> "owner → city". */
export function fieldLabel(value: string): string {
  const bucket = /^(day|week|month|quarter|year)\((.+)\)$/.exec(value);
  if (bucket) return `${bucket[2]} by ${bucket[1]}`;
  return value.replace(".", " → ");
}

/**
 * Pick a field of `table` for an axis or a split: a column, a date column by day/week/...,
 * or a field of the rows a relation links to (either direction).
 */
export function FieldMenu({
  table,
  tables,
  value,
  onChange,
  placeholder,
  allowNone,
  numeric,
  ariaLabel,
}: {
  table: TableInfo;
  /** Every table, to list the fields of linked tables. */
  tables: TableInfo[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  allowNone?: string;
  /** Only number fields (for sum, average, ...). */
  numeric?: boolean;
  ariaLabel: string;
}) {
  const isNumber = (c: TableColumn) => ["number", "currency", "percent"].includes(c.type);
  const fields = table.columns.filter(
    (c) => c.name !== table.primary_key && (!numeric || isNumber(c) || c.type === "relation"),
  );
  const target = (c: TableColumn) => tables.find((t) => t.path === c.target);
  const item = (key: string, label: string, type: string | null, chosen: boolean) => (
    <DropdownMenuItem key={key} onSelect={() => onChange(key)}>
      {type ? <TypeIcon type={type} size={14} /> : <span className="chart-menu-gap" />}
      {label}
      {chosen && <Check className="ml-auto" />}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="chart-select" aria-label={ariaLabel}>
        <span className={value ? "" : "chart-select-empty"}>
          {value ? fieldLabel(value) : placeholder}
        </span>
        <ChevronDown size={13} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="chart-menu">
        {allowNone !== undefined && (
          <>
            {item("", allowNone, null, !value)}
            <DropdownMenuSeparator />
          </>
        )}
        {fields.map((c) => {
          if (c.type === "relation") {
            const other = target(c);
            const otherFields =
              other?.columns.filter(
                (o) =>
                  o.name !== other.primary_key &&
                  o.type !== "relation" &&
                  (!numeric || isNumber(o)),
              ) ?? [];
            return (
              <DropdownMenuSub key={c.name}>
                <DropdownMenuSubTrigger>
                  <TypeIcon type="relation" size={14} /> {c.name}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="chart-menu">
                  {!numeric &&
                    item(c.name, `${other?.name ?? c.name} (name)`, null, value === c.name)}
                  {otherFields.map((o) =>
                    item(`${c.name}.${o.name}`, o.name, o.type, value === `${c.name}.${o.name}`),
                  )}
                  {!other && <div className="chart-menu-note">The linked table is missing.</div>}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          }
          if (c.type === "date" && !numeric)
            return (
              <DropdownMenuSub key={c.name}>
                <DropdownMenuSubTrigger>
                  <TypeIcon type="date" size={14} /> {c.name}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="chart-menu">
                  {BUCKETS.map(([bucket, label]) => {
                    const key = bucket ? `${bucket}(${c.name})` : c.name;
                    return item(key, label, null, value === key);
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          return item(c.name, c.name, c.type, value === c.name);
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
