import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, SlidersHorizontal, Sparkles, TriangleAlert, Undo2, X } from "lucide-react";
import { useDismissableLayerSurface } from "@radix-ui/react-dismissable-layer";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import { cssColor } from "../tables/theme";
import { ChartBuilder } from "./ChartBuilder";
import { buildOption, headline, type ChartColors } from "./option";
import { chartTitle, measureLabel, specToProps, toSpec, yList, type ChartProps } from "./spec";
import { ChartAI } from "./ChartAI";
import { ChartStart } from "./ChartStart";
import { ThemeSwatches } from "./ChartTheme";
import { formatNumber } from "./option";
import { isDark, paletteColors } from "./palettes";
import type { ChartData } from "@/lib/charts";
import { useChartData } from "./useChartData";
import "../views/views.css";
import "../tables/tables.css";
import "./charts.css";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

function readColors(): ChartColors {
  return {
    foreground: cssColor("foreground", "#1a1a1a"),
    muted: cssColor("muted-foreground", "#71717a"),
    border: cssColor("border", "#e4e4e7"),
    background: cssColor("background", "#ffffff"),
    font: getComputedStyle(document.body).fontFamily,
    dark: isDark(),
  };
}

/** Re-read the colors when the app switches between light and dark. */
function useColors(): ChartColors {
  const [colors, setColors] = useState(readColors);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(readColors()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

/** What the headline sums up, in words: "Total across 6 names". */
function description(props: ChartProps, data: ChartData | null): string {
  if (!data) return "";
  const type = props.type || "bar";
  const n = data.categories?.length ?? 0;
  const values = yList(props.y);
  const averaging = values.length > 0 && values.every((v) => /^\s*(avg|min|max)\(/i.test(v));
  const along = props.x ? fieldWords(props.x) : "";
  if (type === "number") return values.length ? measureLabel(values[0]!) : "Rows";
  const what = averaging ? "Average" : values.length ? "Total" : "Rows";
  return n ? `${what} across ${n} ${plural(along || "label", n)}` : what;
}

/** "name" -> "names", "status" -> "statuses", "category" -> "categories". */
function plural(word: string, n: number): string {
  if (n === 1) return word;
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function fieldWords(x: string): string {
  const bucket = /^(day|week|month|quarter|year)\((.+)\)$/.exec(x);
  if (bucket) return bucket[1]!;
  return x.replace(".", " ");
}

function sentence(text: string): string {
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
}

/** Series (or slices) as swatches; a click hides or shows one. */
function Legend({
  items,
  hidden,
  onToggle,
  format,
  layout,
}: {
  items: { name: string; color: string; value?: number | null; share?: number }[];
  hidden: Set<string>;
  onToggle: (name: string) => void;
  format: string;
  layout: "below" | "side";
}) {
  return (
    <div className={`chart-legend ${layout}`}>
      {items.map((item) => (
        <button
          key={item.name}
          type="button"
          className={hidden.has(item.name) ? "off" : ""}
          aria-pressed={!hidden.has(item.name)}
          onClick={() => onToggle(item.name)}
        >
          <i style={{ background: item.color }} />
          <span className="chart-legend-name">{item.name}</span>
          {item.value !== undefined && (
            <span className="chart-legend-value">
              {formatNumber(item.value, format, true)}
              {item.share !== undefined && <small>{Math.round(item.share)}%</small>}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function ChartBody({
  id,
  props,
  editor,
}: {
  id: string;
  props: ChartProps;
  editor: GraiteEditor;
}) {
  const { pagePath } = useContext(MediaContext);
  const dismissSurface = useDismissableLayerSurface();
  const ready = !!(props.sql || (props.source && ((props.type || "bar") === "number" || props.x)));
  const spec = useMemo(() => (ready ? toSpec(props) : null), [ready, props]);
  const { data, error, reload } = useChartData(pagePath ?? null, spec);
  const [editing, setEditing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [asking, setAsking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // The last AI change: what it said, and the chart before it (for Undo).
  const [note, setNote] = useState<{ message: string; before: ChartProps } | null>(null);
  const colors = useColors();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const type = props.type || "bar";
  const pie = type === "pie" || type === "donut";
  const height = props.height || (pie ? 240 : 260);
  const palette = paletteColors(props.palette, colors.dark);

  const update = (next: Partial<ChartProps>) =>
    editor.updateBlock(id, { type: "chart", props: next });
  const apply = (next: ChartProps, message?: string) => {
    if (message) setNote({ message, before: { ...props } });
    else setNote(null);
    setBuilding(false);
    setAsking(false);
    setHidden(new Set());
    update(next);
  };
  const toggle = (name: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const fresh = !props.source && !props.sql;
  const missingField = /\(\s*\)/.test(props.y);
  // The canvas exists only once there is something to draw; set ECharts up when it appears.
  const canvas = ready && !error && type !== "number";

  useLayoutEffect(() => {
    if (!canvas || !box.current) return;
    const instance = echarts.init(box.current, undefined, { renderer: "canvas" });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(box.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [canvas, type]);

  useEffect(() => {
    if (!chart.current || !data || type === "number") return;
    chart.current.setOption(
      buildOption(type, data, colors, {
        stacked: props.stacked === "true",
        palette: props.palette,
        hidden,
      }),
      { notMerge: true },
    );
  }, [data, colors, type, props.stacked, props.palette, canvas, hidden]);

  if (!pagePath) return <div className="table-empty">Save the page before adding a chart.</div>;

  const style = {
    "--chart-1": palette[0],
    "--chart-2": palette[1],
    "--chart-3": palette[2],
  } as React.CSSProperties;

  if (fresh && !building)
    return (
      <div ref={dismissSurface} className="chart-view" style={style} contentEditable={false}>
        <ChartStart
          pagePath={pagePath}
          palette={props.palette}
          colors={colors}
          onPick={apply}
          onBuild={() => setBuilding(true)}
        />
      </div>
    );

  const top = data ? headline(type, data) : null;
  // A trend only means something over time.
  if (top && !/^(day|week|month|quarter|year)\(/.test(props.x)) top.change = null;
  const series = data?.series ?? [];
  const format = series[0]?.format ?? data?.format ?? "number";
  const sliceValues = pie ? (series[0]?.data ?? []).map((v) => Number(v ?? 0)) : [];
  const sliceTotal = sliceValues.reduce((a, b) => a + b, 0);
  const legend = pie
    ? (data?.categories ?? []).map((name, i) => ({
        name,
        color: palette[i % palette.length]!,
        value: sliceValues[i] ?? 0,
        share: sliceTotal ? ((sliceValues[i] ?? 0) / sliceTotal) * 100 : 0,
      }))
    : series.length > 1
      ? series.map((s, i) => ({
          name: s.name,
          color: palette[i % palette.length]!,
          value: undefined as number | undefined,
          share: undefined as number | undefined,
        }))
      : [];
  const shownTotal = pie
    ? legend.filter((l) => !hidden.has(l.name)).reduce((a, l) => a + (l.value ?? 0), 0)
    : null;

  return (
    <div
      ref={dismissSurface}
      className={`chart-view${thinking ? " thinking" : ""}`}
      style={style}
      contentEditable={false}
    >
      <div className="chart-head">
        <div className="chart-heading">
          <span className="chart-label">{sentence(chartTitle(props))}</span>
          {ready && !error && <span className="chart-desc">{description(props, data)}</span>}
        </div>
        <div className="chart-head-side">
          {ready && !error && type !== "donut" && (
            <div className="chart-headline" aria-label="Chart summary">
              <span className="chart-big">
                {top?.value === null || top?.value === undefined
                  ? "—"
                  : formatNumber(top.value, top.format, true)}
              </span>
              {top?.change !== null && top?.change !== undefined && Number.isFinite(top.change) && (
                <span className={`chart-change ${top.change >= 0 ? "up" : "down"}`}>
                  {top.change >= 0 ? "▲" : "▼"} {Math.abs(top.change).toFixed(1)}%
                </span>
              )}
            </div>
          )}
          {!building && (
            <div className="chart-actions">
              <button
                type="button"
                className={`view-button chart-ask-button${asking ? " active" : ""}`}
                onClick={() => setAsking((a) => !a)}
              >
                <Sparkles size={13} /> Ask AI
              </button>
              <Popover>
                <PopoverTrigger className="view-button" aria-label="Colors" title="Colors">
                  <span className="chart-theme-dots small">
                    {palette.slice(0, 4).map((c) => (
                      <i key={c} style={{ background: c }} />
                    ))}
                  </span>
                </PopoverTrigger>
                <PopoverContent align="end" className="chart-themes-popover">
                  <ThemeSwatches value={props.palette} onChange={(p) => update({ palette: p })} />
                </PopoverContent>
              </Popover>
              <Popover open={editing} onOpenChange={setEditing}>
                <PopoverTrigger className="view-button" aria-label="Edit chart">
                  <SlidersHorizontal size={13} />
                  Edit
                </PopoverTrigger>
                <PopoverContent align="end" className="chart-builder-popover">
                  <ChartBuilder pagePath={pagePath} props={props} onChange={update} />
                </PopoverContent>
              </Popover>
              {ready && (
                <button
                  type="button"
                  className="view-button"
                  title="Reload"
                  aria-label="Reload chart"
                  onClick={reload}
                >
                  <RefreshCw size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {building && (
        <div className="chart-inline-builder">
          <ChartBuilder pagePath={pagePath} props={props} onChange={update} />
          <button type="button" className="chart-start-build" onClick={() => setBuilding(false)}>
            Done
          </button>
        </div>
      )}
      {asking && (
        <ChartAI
          pagePath={pagePath}
          autoFocus
          current={{ ...toSpec(props), ...(props.title ? { title: props.title } : {}) }}
          placeholder="Change this chart… as a line · only Done · in Ocean colors"
          onBusy={setThinking}
          onResult={(next, message) =>
            apply(specToProps(next, { height: props.height, palette: props.palette }), message)
          }
        />
      )}
      {note && (
        <div className="chart-note">
          <Sparkles size={13} />
          <span>{note.message}</span>
          <button type="button" onClick={() => apply(note.before)}>
            <Undo2 size={12} /> Undo
          </button>
          <button type="button" aria-label="Dismiss" onClick={() => setNote(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      {missingField && (
        <button type="button" className="chart-prompt" onClick={() => setEditing(true)}>
          Pick the number field to show — this chart counts rows until then.
        </button>
      )}
      {type !== "number" && <div className="chart-divider" />}
      {!ready ? (
        <div className="chart-empty">Choose a table and a field above, or ask AI.</div>
      ) : error ? (
        <div className="table-warning">
          <TriangleAlert size={13} />
          <span>{error}</span>
        </div>
      ) : null}
      {canvas &&
        (pie ? (
          <div className="chart-pie-layout">
            <div className="chart-pie" style={{ height }}>
              <div ref={box} className="chart-canvas" style={{ height }} />
              {type === "donut" && (
                <div className="chart-center">
                  <span>{formatNumber(shownTotal, format, true)}</span>
                  <small>{yList(props.y).length ? "Total" : "Rows"}</small>
                </div>
              )}
            </div>
            <Legend
              items={legend}
              hidden={hidden}
              onToggle={toggle}
              format={format}
              layout="side"
            />
          </div>
        ) : (
          <>
            <div ref={box} className="chart-canvas" style={{ height }} />
            {legend.length > 1 && (
              <Legend
                items={legend}
                hidden={hidden}
                onToggle={toggle}
                format={format}
                layout="below"
              />
            )}
          </>
        ))}
    </div>
  );
}
