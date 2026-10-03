import { useEffect, useMemo, useState } from "react";
import {
  AreaChart,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Hash,
  LineChart,
  PieChart,
  ScatterChart,
  Sparkles,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sourceFor, tables as tablesApi, type TableInfo } from "@/lib/tables";
import { TypeIcon } from "../tables/columns";
import { FieldMenu } from "./FieldMenu";
import { CHART_TYPES, chartTitle, yList, type ChartProps, type ChartType } from "./spec";
import { defaultChart, numberFields } from "./suggest";
import { ThemeSwatches } from "./ChartTheme";

const TYPE_ICONS: Record<ChartType, LucideIcon> = {
  bar: BarChart3,
  line: LineChart,
  area: AreaChart,
  pie: PieChart,
  donut: CircleDot,
  scatter: ScatterChart,
  number: Hash,
};

const AGGREGATES = [
  ["sum", "Sum"],
  ["avg", "Average"],
  ["min", "Minimum"],
  ["max", "Maximum"],
] as const;
type Agg = (typeof AGGREGATES)[number][0];

const SORTS = [
  ["", "Automatic"],
  ["y desc", "Largest first"],
  ["y asc", "Smallest first"],
  ["x asc", "Labels A → Z"],
  ["x desc", "Labels Z → A"],
] as const;

/** Tables a chart on `pagePath` may read: its own and its subpages', plus those they link to. */
export function chartTables(pagePath: string, all: TableInfo[]): TableInfo[] {
  const byPath = new Map(all.map((t) => [t.path, t]));
  const seen = new Set(
    all
      .filter((t) => t.page_path === pagePath || t.page_path.startsWith(pagePath + "/"))
      .map((t) => t.path),
  );
  const queue = [...seen];
  while (queue.length) {
    for (const c of byPath.get(queue.pop()!)?.columns ?? [])
      if (c.type === "relation" && c.target && !seen.has(c.target)) {
        seen.add(c.target);
        queue.push(c.target);
      }
  }
  return all.filter((t) => seen.has(t.path));
}

/** One value of `y`: a number field with how it adds up, or the row count. */
interface Value {
  field: string; // "" = count of rows
  agg: Agg;
}

function parseValues(y: string): Value[] {
  return yList(y).map((v) => {
    const m = /^\s*(count|sum|avg|min|max)\s*(?:\(\s*(.*?)\s*\))?\s*$/i.exec(v);
    if (!m) return { field: v.trim(), agg: "sum" };
    const agg = m[1]!.toLowerCase();
    if (agg === "count") return { field: "", agg: "sum" };
    return { field: m[2] ?? "", agg: agg as Agg };
  });
}

/** Back to the fence: a plain column for sums (`rating`), `avg(rating)` for the rest. */
function writeValues(values: Value[]): string {
  const ys = values
    .filter((v) => v.field)
    .map((v) => (v.agg === "sum" ? v.field : `${v.agg}(${v.field})`));
  if (!ys.length) return "";
  return ys.length === 1 ? ys[0]! : JSON.stringify(ys);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="chart-builder-row">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

/** Edit a chart block: what to show, along what, as which chart. Anything else: ask AI. */
export function ChartBuilder({
  pagePath,
  props,
  onChange,
}: {
  pagePath: string;
  props: ChartProps;
  onChange: (next: Partial<ChartProps>) => void;
}) {
  const [all, setAll] = useState<TableInfo[]>([]);
  const [more, setMore] = useState(false);
  useEffect(() => {
    tablesApi
      .list()
      .then(setAll)
      .catch(() => setAll([]));
  }, []);
  const choices = useMemo(() => chartTables(pagePath, all), [pagePath, all]);
  const table = choices.find(
    (t) =>
      sourceFor(pagePath, t) === props.source || t.path === props.source || t.name === props.source,
  );
  const type = (props.type || "bar") as ChartType;
  const numbers = useMemo(() => (table ? numberFields(table, all) : []), [table, all]);
  const values = parseValues(props.y);
  const single = ["pie", "donut", "number", "scatter"].includes(type) || !!props.series;

  const setValues = (next: Value[]) => onChange({ y: writeValues(next) });
  const toggle = (field: string) => {
    if (!field) return setValues([]);
    const has = values.some((v) => v.field === field);
    if (single) return setValues(has ? [] : [{ field, agg: "sum" }]);
    setValues(
      has
        ? values.filter((v) => v.field !== field)
        : [...values.filter((v) => v.field), { field, agg: "sum" }],
    );
  };
  const setType = (t: ChartType) => {
    const patch: Partial<ChartProps> = { type: t === "bar" ? "" : t };
    if (["pie", "donut", "number", "scatter"].includes(t) && values.length > 1)
      patch.y = writeValues(values.slice(0, 1));
    if (t === "number") patch.series = "";
    onChange(patch);
  };
  const chooseTable = (t: TableInfo) =>
    onChange({ sql: "", series: "", filter: "", sort: "", ...defaultChart(pagePath, t, all) });

  return (
    <div className="chart-builder">
      <div className="chart-types" role="radiogroup" aria-label="Chart type">
        {CHART_TYPES.filter(
          ([t]) => t !== "scatter" || numbers.length > 1 || type === "scatter",
        ).map(([t, label]) => {
          const Icon = TYPE_ICONS[t];
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {props.sql ? (
        <div className="chart-ai-note">
          <Sparkles size={13} />
          <span>
            Made by AI from a query. Describe what to change and AI proposes a new version.
          </span>
        </div>
      ) : (
        <>
          {(choices.length !== 1 || !table) && (
            <Row label="Table">
              <DropdownMenu>
                <DropdownMenuTrigger className="chart-select" aria-label="Source table">
                  <span className={table ? "" : "chart-select-empty"}>
                    {table?.name ?? "Choose a table"}
                  </span>
                  <ChevronDown size={13} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="chart-menu">
                  {choices.length === 0 && (
                    <div className="chart-menu-note">
                      This page and its subpages have no tables yet.
                    </div>
                  )}
                  {[...new Set(choices.map((t) => t.page_path))].map((page, i) => (
                    <div key={page}>
                      {i > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="table-menu-label">{page}</DropdownMenuLabel>
                      {choices
                        .filter((t) => t.page_path === page)
                        .map((t) => (
                          <DropdownMenuItem key={t.path} onSelect={() => chooseTable(t)}>
                            <Table2 />
                            {t.name}
                            {t.path === table?.path && <Check className="ml-auto" />}
                          </DropdownMenuItem>
                        ))}
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </Row>
          )}

          {table && (
            <div className="chart-section">
              <div className="chart-section-title">Show</div>
              <div className="chart-values" role="listbox" aria-label="Values to show">
                <button
                  type="button"
                  role="option"
                  aria-selected={!values.some((v) => v.field)}
                  className="chart-value"
                  onClick={() => toggle("")}
                >
                  <Hash size={14} />
                  <span>Count of rows</span>
                  {!values.some((v) => v.field) && <Check size={14} className="ml-auto" />}
                </button>
                {numbers.map((n) => {
                  const chosen = values.find((v) => v.field === n.key);
                  return (
                    <div
                      key={n.key}
                      role="option"
                      aria-selected={!!chosen}
                      className={`chart-value${chosen ? " chosen" : ""}`}
                      onClick={() => toggle(n.key)}
                    >
                      <TypeIcon type={n.column.type} size={14} />
                      <span>{n.label}</span>
                      {chosen && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            className="chart-agg"
                            aria-label={`How ${n.label} adds up`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {AGGREGATES.find(([a]) => a === chosen.agg)?.[1]}
                            <ChevronDown size={11} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="chart-menu">
                            {AGGREGATES.map(([a, label]) => (
                              <DropdownMenuItem
                                key={a}
                                onSelect={() =>
                                  setValues(
                                    values.map((v) => (v.field === n.key ? { ...v, agg: a } : v)),
                                  )
                                }
                              >
                                {label}
                                {a === chosen.agg && <Check className="ml-auto" />}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      {chosen && <Check size={14} className="chart-value-check" />}
                    </div>
                  );
                })}
              </div>
              {numbers.length === 0 && (
                <p className="chart-hint">
                  Add a number field to {table.name} to chart values; for now this counts rows.
                </p>
              )}
              {numbers.length > 1 && !single && (
                <p className="chart-hint">Pick several to compare them side by side.</p>
              )}
            </div>
          )}

          {table && type !== "number" && (
            <Row
              label={
                type === "pie" || type === "donut"
                  ? "Slices"
                  : type === "scatter"
                    ? "Against"
                    : "Along"
              }
            >
              <FieldMenu
                table={table}
                tables={all}
                value={props.x}
                onChange={(x) => onChange({ x })}
                placeholder="Choose a field"
                numeric={type === "scatter"}
                ariaLabel="Along"
              />
            </Row>
          )}
          {table &&
            ["bar", "line", "area"].includes(type) &&
            values.filter((v) => v.field).length <= 1 && (
              <Row label="Split by">
                <FieldMenu
                  table={table}
                  tables={all}
                  value={props.series}
                  onChange={(series) => onChange({ series })}
                  placeholder="Nothing"
                  allowNone="Nothing"
                  ariaLabel="Split by"
                />
              </Row>
            )}
        </>
      )}

      <button
        type="button"
        className="chart-more"
        aria-expanded={more}
        onClick={() => setMore((m) => !m)}
      >
        <ChevronRight size={13} className={more ? "open" : ""} />
        More options
      </button>
      {more && (
        <div className="chart-more-body">
          {table && !props.sql && (
            <Row label="Filter">
              <FilterInput value={props.filter} onCommit={(filter) => onChange({ filter })} />
            </Row>
          )}
          {type !== "number" && type !== "scatter" && (
            <Row label="Order">
              <DropdownMenu>
                <DropdownMenuTrigger className="chart-select" aria-label="Order">
                  <span>{SORTS.find(([s]) => s === props.sort)?.[1] ?? props.sort}</span>
                  <ChevronDown size={13} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="chart-menu">
                  {SORTS.map(([s, label]) => (
                    <DropdownMenuItem key={s} onSelect={() => onChange({ sort: s })}>
                      {label}
                      {s === props.sort && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                className="table-input chart-limit"
                type="number"
                min={1}
                max={500}
                placeholder="All"
                aria-label="Show at most"
                title="Show at most this many labels"
                value={props.limit || ""}
                onChange={(e) =>
                  onChange({ limit: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })
                }
              />
            </Row>
          )}
          {["bar", "line", "area"].includes(type) && (
            <Row label="Stacked">
              <Switch
                size="sm"
                checked={props.stacked === "true"}
                onCheckedChange={(on) => onChange({ stacked: on ? "true" : "" })}
                aria-label="Stack series"
              />
            </Row>
          )}
          <div className="chart-section">
            <div className="chart-section-title">Colors</div>
            <ThemeSwatches value={props.palette} onChange={(palette) => onChange({ palette })} />
          </div>
          <Row label="Title">
            <input
              className="table-input"
              placeholder={chartTitle({ ...props, title: "" })}
              value={props.title}
              maxLength={120}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </Row>
        </div>
      )}
    </div>
  );
}

/** The filter as text, applied on Enter or when the field loses focus. */
function FilterInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="table-input mono"
      placeholder='e.g. status = "Done"'
      aria-label="Filter"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
