import type { EChartsOption, SeriesOption } from "echarts";
import type { ChartData } from "@/lib/charts";
import { fade, paletteColors } from "./palettes";

/** The default grayscale colors in light mode, for consumers that need a static palette. */
export const PALETTE = [...paletteColors("mono", false)];

export interface ChartColors {
  foreground: string;
  muted: string;
  border: string;
  background: string;
  font: string;
  dark?: boolean;
}

/** A value as the chart shows it: `number`, `percent` or `currency:EUR` (from the daemon). */
export function formatNumber(value: unknown, format = "number", compact = false): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const short = compact && Math.abs(n) >= 10_000;
  try {
    if (format.startsWith("currency:"))
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: format.slice(9) || "EUR",
        notation: short ? "compact" : "standard",
        maximumFractionDigits: short || Number.isInteger(n) ? 0 : 2,
      }).format(n);
  } catch {
    /* An unknown currency code: plain number below. */
  }
  const text = new Intl.NumberFormat(undefined, {
    notation: short ? "compact" : "standard",
    maximumFractionDigits: short ? 1 : 2,
  }).format(n);
  return format === "percent" ? `${text}%` : text;
}

/** The headline number over a chart: the total (or average, for averages) of what it shows,
 *  and for a line over time how much the last point differs from the first. */
export function headline(
  type: string,
  data: ChartData,
): { value: number | null; format: string; change: number | null } {
  const series = data.series ?? [];
  const format = series[0]?.format ?? data.format ?? "number";
  if (type === "number") return { value: data.value ?? null, format, change: null };
  const values = series.flatMap((s) => s.data).filter((v): v is number => typeof v === "number");
  if (!values.length) return { value: null, format, change: null };
  const averaging = series.every((s) => /^(Average|Minimum|Maximum)\b/.test(s.name));
  const total = values.reduce((a, b) => a + b, 0);
  const value = averaging ? total / values.length : total;
  let change: number | null = null;
  if ((type === "line" || type === "area") && series.length === 1) {
    const points = (series[0]!.data as (number | null)[]).filter(
      (v): v is number => typeof v === "number",
    );
    const first = points[0];
    const last = points[points.length - 1];
    if (points.length > 1 && first) change = ((last! - first) / Math.abs(first)) * 100;
  }
  return { value, format, change };
}

/** `rgba(r, g, b, a)` (from the theme) at another alpha. */
function translucent(color: string, alpha: number): string {
  const m = /rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(color);
  return m ? `rgba(${m[1]},${m[2]},${m[3]}, ${alpha})` : color;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

/** A frosted tooltip: the label, then a row per series with its swatch and value. */
function tooltipRows(
  title: string,
  rows: { color: string; name: string; value: unknown }[],
  format: string,
): string {
  return (
    `<div class="chart-tip-title">${escapeHtml(title)}</div>` +
    rows
      .map(
        (r) =>
          `<div class="chart-tip-row"><i style="background:${r.color}"></i>` +
          `<span>${escapeHtml(r.name)}</span><b>${escapeHtml(formatNumber(r.value, format))}</b></div>`,
      )
      .join("")
  );
}

export interface OptionSettings {
  stacked?: boolean;
  palette?: string;
  /** A thumbnail: no axes, labels or tooltip. */
  mini?: boolean;
  /** Series or slices switched off in the legend. */
  hidden?: Set<string>;
}

/** The ECharts option for one chart (everything but `number`, which is HTML). The legend,
 *  the donut's center and the headline are HTML around the canvas (ChartBody). */
export function buildOption(
  type: string,
  data: ChartData,
  colors: ChartColors,
  opts: OptionSettings = {},
): EChartsOption {
  const palette = paletteColors(opts.palette, colors.dark);
  const color = (i: number) => palette[i % palette.length]!;
  const mini = !!opts.mini;
  const axisText = { color: colors.muted, fontFamily: colors.font, fontSize: 11 };
  const series = data.series ?? [];
  const categories = data.categories ?? [];
  const format = series[0]?.format ?? "number";
  const pie = type === "pie" || type === "donut";
  const hidden = opts.hidden ?? new Set<string>();
  const tooltip = mini
    ? { show: false }
    : {
        trigger: (pie || type === "scatter" ? "item" : "axis") as "item" | "axis",
        backgroundColor: translucent(colors.background, colors.dark ? 0.72 : 0.82),
        borderColor: colors.border,
        borderWidth: 1,
        padding: [8, 10],
        className: "chart-tip",
        extraCssText:
          "border-radius:10px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);" +
          "box-shadow:0 12px 32px -14px rgba(0,0,0,.28);",
        textStyle: { color: colors.foreground, fontFamily: colors.font, fontSize: 12 },
        axisPointer: {
          type: "line" as const,
          lineStyle: { color: colors.muted, type: "dashed" as const, width: 1, opacity: 0.6 },
        },
      };
  const base: EChartsOption = {
    color: [...palette],
    backgroundColor: "transparent",
    textStyle: { fontFamily: colors.font, color: colors.foreground },
    animationDuration: mini ? 0 : 700,
    animationEasing: "cubicOut",
  };

  if (pie) {
    const values = (series[0]?.data ?? []).map((v) => Number(v ?? 0));
    const donut = type === "donut";
    return {
      ...base,
      tooltip: {
        ...tooltip,
        formatter: (p: unknown) => {
          const item = p as { name: string; value: number; color: string; percent: number };
          return tooltipRows(
            item.name,
            [{ color: item.color, name: `${Math.round(item.percent)}%`, value: item.value }],
            format,
          );
        },
      },
      series: [
        {
          type: "pie",
          radius: donut ? ["58%", "82%"] : ["0%", "82%"],
          center: ["50%", "50%"],
          startAngle: 90,
          padAngle: 0,
          minAngle: 2,
          selectedOffset: 0,
          avoidLabelOverlap: true,
          itemStyle: {
            borderRadius: 0,
            borderColor: colors.background,
            borderWidth: mini ? 1 : 2,
            borderCap: "butt",
            borderJoin: "miter",
            borderMiterLimit: 10,
          },
          label: { show: false },
          labelLine: { show: false },
          emphasis: {
            scale: false,
            itemStyle: { borderRadius: 0, borderCap: "butt", borderJoin: "miter" },
          },
          data: categories
            .map((name, i) => ({ name, value: values[i] ?? 0, itemStyle: { color: color(i) } }))
            .filter((d) => !hidden.has(d.name)),
        },
      ],
    };
  }

  const axis = {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { ...axisText, hideOverlap: true, margin: 10 },
    splitLine: { lineStyle: { color: colors.border, type: "solid" as const, opacity: 0.55 } },
  };
  const grid = mini
    ? { left: 2, right: 2, top: 4, bottom: 2 }
    : { left: 2, right: 10, top: 18, bottom: 2, containLabel: true };
  const off = mini ? { show: false } : {};
  const axisTooltip = {
    ...tooltip,
    formatter: (p: unknown) => {
      const items = p as {
        axisValueLabel: string;
        seriesName: string;
        value: unknown;
        color: unknown;
      }[];
      return tooltipRows(
        items[0]?.axisValueLabel ?? "",
        items.map((i, n) => ({
          color: typeof i.color === "string" ? i.color : color(n),
          name: i.seriesName,
          value: i.value,
        })),
        format,
      );
    },
  };

  if (type === "scatter") {
    return {
      ...base,
      tooltip: { ...tooltip, trigger: "item" },
      grid,
      xAxis: { type: "value", scale: true, ...axis, splitLine: { show: false }, ...off },
      yAxis: { type: "value", scale: true, ...axis, ...off },
      series: [
        {
          type: "scatter",
          symbolSize: mini ? 5 : 9,
          itemStyle: {
            color: fade(color(0), 0.82),
            borderColor: colors.background,
            borderWidth: mini ? 0 : 1.5,
          },
          data: (data.points ?? []).map((p) => p.map((v) => (v === null ? 0 : Number(v)))),
        },
      ],
    };
  }

  const line = type === "line" || type === "area";
  const whole = series.every((s) => s.data.every((v) => v === null || Number.isInteger(v)));
  return {
    ...base,
    tooltip: axisTooltip,
    grid,
    xAxis: {
      type: "category",
      data: categories,
      boundaryGap: !line,
      ...axis,
      axisLabel: { ...axis.axisLabel, width: 90, overflow: "truncate" },
      splitLine: { show: false },
      ...off,
    },
    yAxis: {
      type: "value",
      ...axis,
      minInterval: whole ? 1 : undefined,
      splitNumber: 4,
      axisLabel: { ...axisText, formatter: (v: number) => formatNumber(v, format, true) },
      ...off,
    },
    series: series
      .filter((s) => !hidden.has(s.name))
      .map((s): SeriesOption => {
        const i = series.indexOf(s);
        const c = color(i);
        const values = s.data as (number | null)[];
        if (line)
          return {
            type: "line",
            name: s.name,
            data: values,
            smooth: 0.28,
            showSymbol: false,
            symbol: "circle",
            symbolSize: 9,
            stack: opts.stacked ? "all" : undefined,
            lineStyle: { width: mini ? 1.5 : 2.5, color: c },
            itemStyle: { color: c, borderColor: colors.background, borderWidth: 2 },
            areaStyle:
              type === "area"
                ? {
                    color: {
                      type: "linear",
                      x: 0,
                      y: 0,
                      x2: 0,
                      y2: 1,
                      colorStops: [
                        { offset: 0, color: fade(c, 0.24) },
                        { offset: 1, color: fade(c, 0.015) },
                      ],
                    },
                  }
                : undefined,
            emphasis: {
              focus: "series",
              itemStyle: { shadowBlur: 0, borderWidth: 3, borderColor: fade(c, 0.25) },
            },
          };
        const radius = opts.stacked
          ? i === series.length - 1
            ? [6, 6, 0, 0]
            : 0
          : mini
            ? [3, 3, 0, 0]
            : [5, 5, 1, 1];
        return {
          type: "bar",
          name: s.name,
          data: values,
          stack: opts.stacked ? "all" : undefined,
          barMaxWidth: mini ? 14 : 32,
          barCategoryGap: "34%",
          barGap: "22%",
          itemStyle: { borderRadius: radius as number | number[], color: c },
          emphasis: { itemStyle: { color: c } },
        };
      }),
  };
}
