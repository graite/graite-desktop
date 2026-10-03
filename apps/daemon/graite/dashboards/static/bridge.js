/*
 * The Graite dashboard bridge (D72), inlined into every dashboard frame after ECharts.
 *
 * A dashboard is a page's own HTML file, shown in a sandboxed iframe with no network and no
 * access to the app. It reaches its data only through `window.graite`, which asks the app
 * over postMessage:
 *
 *   const rows = await graite.query("SELECT brand, count(*) AS n FROM cars GROUP BY brand");
 *   graite.chart("#by-brand", { source: "cars", type: "bar", x: "brand" });
 *   graite.chart(el, echartsOption);            // any ECharts option, themed
 *   graite.onChange(() => refresh());           // a table the page reads changed
 *   const page = await graite.page();           // { path, title }
 *   const t = graite.theme();                   // { mode, colors: { background, ... } }
 *
 * Charts made with graite.chart follow the theme, resize with their element and redraw
 * themselves when the data changes.
 */
(() => {
  "use strict";
  const pending = new Map();
  const listeners = new Set();
  const charts = new Map();
  let seq = 0;
  let theme = {
    mode: "light",
    colors: {
      background: "#ffffff",
      foreground: "#1a1a1a",
      muted: "#71717a",
      border: "#e4e4e7",
      accent: "#f4f4f5",
      palette: [
        "#0a0a0a",
        "#262626",
        "#3d3d3d",
        "#545454",
        "#6b6b6b",
        "#7d7d7d",
        "#949494",
        "#ababab",
      ],
    },
    font: "system-ui, sans-serif",
  };

  function call(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      parent.postMessage({ graite: 1, id, method, args }, "*");
    });
  }

  function applyTheme() {
    const c = theme.colors;
    const root = document.documentElement.style;
    root.setProperty("--graite-bg", c.background);
    root.setProperty("--graite-fg", c.foreground);
    root.setProperty("--graite-muted", c.muted);
    root.setProperty("--graite-border", c.border);
    root.setProperty("--graite-accent", c.accent);
    root.setProperty("--graite-font", theme.font);
    c.palette.forEach((color, i) => root.setProperty(`--graite-color-${i + 1}`, color));
    document.documentElement.dataset.theme = theme.mode;
  }

  function el(target) {
    const node = typeof target === "string" ? document.querySelector(target) : target;
    if (!node) throw new Error(`graite.chart: no element ${target}`);
    if (!node.style.height && node.clientHeight < 40) node.style.height = "280px";
    return node;
  }

  /* The chart color themes, light and dark shades (apps/desktop/src/editor/charts/palettes.ts). */
  const PALETTES = {
    vivid: [
      ["#3978f6", "#12a594", "#7c5ce7", "#e59428", "#dc5b73", "#1689ad", "#6f7d91", "#55a45c"],
      ["#6ea0ff", "#42c7b3", "#a78bfa", "#f2b950", "#f08093", "#49b7d7", "#9aa7b8", "#79c57f"],
    ],
    ocean: [
      ["#1976a8", "#179bb1", "#22a696", "#396ecb", "#5a65c7", "#2b8494", "#67a7c5", "#466c80"],
      ["#55b6e7", "#4fc9dc", "#50cfbd", "#769cff", "#9999ff", "#70bdca", "#93cce5", "#7fa7ba"],
    ],
    sunset: [
      ["#e26345", "#eb913d", "#e3b446", "#bf6682", "#8a67bf", "#4f82c4", "#45a1a7", "#718096"],
      ["#f58a6e", "#f6b15f", "#efd16e", "#df8ba2", "#b293df", "#7eace8", "#72c6c9", "#9ca8b8"],
    ],
    forest: [
      ["#31866f", "#66a05c", "#94ad55", "#c2a34a", "#3d8391", "#667c52", "#9a7651", "#65758a"],
      ["#61b99e", "#8ac67e", "#b5ce76", "#dec56c", "#68afbd", "#93a978", "#c59d75", "#91a0b3"],
    ],
    candy: [
      ["#5677e8", "#9a62db", "#e05f9d", "#ef7a58", "#dfa92f", "#54a97d", "#31a4b7", "#77859a"],
      ["#809bff", "#bd8aef", "#f18bbb", "#f59b7f", "#edc45f", "#7ac89f", "#64c4d1", "#a0abbb"],
    ],
    mono: [
      ["#0a0a0a", "#262626", "#3d3d3d", "#545454", "#6b6b6b", "#7d7d7d", "#949494", "#ababab"],
      ["#ffffff", "#dedede", "#bebebe", "#a0a0a0", "#868686", "#6f6f6f", "#5a5a5a", "#484848"],
    ],
  };
  const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

  function fade(hex, alpha) {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /* `number`, `percent` or `currency:EUR`, like the app's charts. */
  function formatValue(value, format, compact) {
    if (value === null || value === undefined || value === "") return "—";
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    const fmt = format || "number";
    const short = compact && Math.abs(n) >= 10000;
    if (fmt.startsWith("currency:")) {
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: fmt.slice(9) || "EUR",
          notation: short ? "compact" : "standard",
          maximumFractionDigits: short || Number.isInteger(n) ? 0 : 2,
        }).format(n);
      } catch (e) {
        /* plain number below */
      }
    }
    const text = new Intl.NumberFormat(undefined, {
      notation: short ? "compact" : "standard",
      maximumFractionDigits: short ? 1 : 2,
    }).format(n);
    return fmt === "percent" ? `${text}%` : text;
  }

  function esc(text) {
    return String(text).replace(
      /[&<>"]/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
    );
  }

  function tipRows(title, rows, format) {
    const c = theme.colors;
    return (
      `<div style="font-size:11px;color:${c.muted};margin-bottom:4px">${esc(title)}</div>` +
      rows
        .map(
          (r) =>
            `<div style="display:flex;align-items:center;gap:8px;min-width:140px;font-size:12px">` +
            `<i style="width:10px;height:10px;border-radius:3px;background:${r.color}"></i>` +
            `<span>${esc(r.name)}</span><b style="margin-left:auto;font-family:${MONO}">` +
            `${esc(formatValue(r.value, format))}</b></div>`,
        )
        .join("")
    );
  }

  /* The same look as the app's chart blocks (apps/desktop/src/editor/charts/option.ts). */
  function option(type, data, stacked, paletteName) {
    const c = theme.colors;
    const dark = theme.mode === "dark";
    const named = PALETTES[paletteName] || PALETTES.mono;
    const palette = named[dark ? 1 : 0];
    const color = (i) => palette[i % palette.length];
    const axisText = { color: c.muted, fontFamily: theme.font, fontSize: 11 };
    const series = data.series || [];
    const categories = data.categories || [];
    const format = (series[0] && series[0].format) || "number";
    const pie = type === "pie" || type === "donut";
    const tooltip = {
      trigger: pie || type === "scatter" ? "item" : "axis",
      backgroundColor: dark ? "rgba(10,10,10,0.72)" : "rgba(255,255,255,0.85)",
      borderColor: c.border,
      borderWidth: 1,
      padding: [8, 10],
      extraCssText:
        "border-radius:10px;backdrop-filter:blur(12px);box-shadow:0 12px 32px -14px rgba(0,0,0,.28);",
      textStyle: { color: c.foreground, fontFamily: theme.font, fontSize: 12 },
      axisPointer: {
        type: "line",
        lineStyle: { color: c.muted, type: "dashed", width: 1, opacity: 0.6 },
      },
    };
    const base = {
      color: palette,
      backgroundColor: "transparent",
      textStyle: { fontFamily: theme.font, color: c.foreground },
      animationDuration: 700,
      animationEasing: "cubicOut",
    };
    if (pie) {
      const values = ((series[0] && series[0].data) || []).map((v) => Number(v || 0));
      const donut = type === "donut";
      return Object.assign(base, {
        tooltip: Object.assign({}, tooltip, {
          formatter: (p) =>
            tipRows(
              p.name,
              [{ color: p.color, name: `${Math.round(p.percent)}%`, value: p.value }],
              format,
            ),
        }),
        series: [
          {
            type: "pie",
            radius: donut ? ["58%", "82%"] : ["0%", "82%"],
            center: ["50%", "50%"],
            startAngle: 90,
            padAngle: 0,
            minAngle: 2,
            selectedOffset: 0,
            itemStyle: {
              borderRadius: 0,
              borderColor: c.background,
              borderWidth: 2,
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
            data: categories.map((name, i) => ({
              name,
              value: values[i] || 0,
              itemStyle: { color: color(i) },
            })),
          },
        ],
      });
    }
    const axis = {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: Object.assign({ hideOverlap: true, margin: 10 }, axisText),
      splitLine: { lineStyle: { color: c.border, type: "solid", opacity: 0.55 } },
    };
    const grid = { left: 2, right: 10, top: 18, bottom: 2, containLabel: true };
    const axisTooltip = Object.assign({}, tooltip, {
      formatter: (items) =>
        tipRows(
          items[0] ? items[0].axisValueLabel : "",
          items.map((i, n) => ({
            color: typeof i.color === "string" ? i.color : color(n),
            name: i.seriesName,
            value: i.value,
          })),
          format,
        ),
    });
    if (type === "scatter") {
      return Object.assign(base, {
        tooltip: Object.assign({}, tooltip, { trigger: "item" }),
        grid,
        xAxis: Object.assign({ type: "value", scale: true }, axis, { splitLine: { show: false } }),
        yAxis: Object.assign({ type: "value", scale: true }, axis),
        series: [
          {
            type: "scatter",
            symbolSize: 9,
            itemStyle: { color: fade(color(0), 0.82), borderColor: c.background, borderWidth: 1.5 },
            data: data.points || [],
          },
        ],
      });
    }
    const line = type === "line" || type === "area";
    const whole = series.every((s) => s.data.every((v) => v === null || Number.isInteger(v)));
    return Object.assign(base, {
      tooltip: axisTooltip,
      grid,
      xAxis: Object.assign({ type: "category", data: categories, boundaryGap: !line }, axis, {
        axisLabel: Object.assign(
          { hideOverlap: true, margin: 10, width: 90, overflow: "truncate" },
          axisText,
        ),
        splitLine: { show: false },
      }),
      yAxis: Object.assign(
        { type: "value", minInterval: whole ? 1 : undefined, splitNumber: 4 },
        axis,
        {
          axisLabel: Object.assign({}, axisText, {
            formatter: (v) => formatValue(v, format, true),
          }),
        },
      ),
      series: series.map((s, i) => {
        const col = color(i);
        if (line) {
          return {
            type: "line",
            name: s.name,
            data: s.data,
            smooth: 0.28,
            showSymbol: false,
            symbol: "circle",
            symbolSize: 9,
            stack: stacked ? "all" : undefined,
            lineStyle: { width: 2.5, color: col },
            itemStyle: { color: col, borderColor: c.background, borderWidth: 2 },
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
                        { offset: 0, color: fade(col, 0.24) },
                        { offset: 1, color: fade(col, 0.015) },
                      ],
                    },
                  }
                : undefined,
            emphasis: {
              focus: "series",
              itemStyle: { borderWidth: 3, borderColor: fade(col, 0.25) },
            },
          };
        }
        return {
          type: "bar",
          name: s.name,
          stack: stacked ? "all" : undefined,
          data: s.data,
          barMaxWidth: 32,
          barCategoryGap: "34%",
          barGap: "22%",
          itemStyle: {
            borderRadius: stacked ? (i === series.length - 1 ? [5, 5, 0, 0] : 0) : [5, 5, 1, 1],
            color: col,
          },
          emphasis: { itemStyle: { color: col } },
        };
      }),
    });
  }

  function numberTile(node, data, spec) {
    const value = formatValue(data.value, data.format);
    node.innerHTML = "";
    const big = document.createElement("div");
    big.textContent = value;
    big.style.cssText = `font-family:${MONO};font-size:30px;font-weight:600;letter-spacing:-0.04em;line-height:1.15`;
    const small = document.createElement("div");
    small.textContent = spec.title || data.label || "";
    small.style.cssText = "font-size:12px;color:var(--graite-muted);margin-top:2px";
    node.append(big, small);
  }

  async function draw(entry) {
    const { node, spec, raw } = entry;
    if (raw) {
      entry.instance.setOption(withTheme(spec), { notMerge: true });
      return;
    }
    try {
      const data = await call("chart", { spec });
      const type = spec.type || "bar";
      if (type === "number") return numberTile(node, data, spec);
      entry.instance.setOption(option(type, data, spec.stacked === true, spec.palette), {
        notMerge: true,
      });
    } catch (error) {
      node.textContent = String(error.message || error);
      node.style.color = "var(--graite-muted)";
      node.style.fontSize = "12px";
    }
  }

  function withTheme(opt) {
    return Object.assign(
      {
        color: theme.colors.palette,
        backgroundColor: "transparent",
        textStyle: { fontFamily: theme.font, color: theme.colors.foreground },
      },
      opt,
    );
  }

  const resize = new ResizeObserver((entries) => {
    for (const e of entries) {
      const entry = charts.get(e.target);
      if (entry && entry.instance) entry.instance.resize();
    }
    reportHeight();
  });

  function reportHeight() {
    parent.postMessage(
      { graite: 1, event: "height", value: document.documentElement.scrollHeight },
      "*",
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const m = event.data;
    if (!m || m.graite !== 1) return;
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    } else if (m.event === "theme") {
      theme = m.theme;
      applyTheme();
      charts.forEach((entry) => draw(entry));
    } else if (m.event === "change") {
      charts.forEach((entry) => {
        if (!entry.raw) draw(entry);
      });
      listeners.forEach((cb) => {
        try {
          cb(m.detail || {});
        } catch (error) {
          console.error(error);
        }
      });
    }
  });

  window.graite = Object.freeze({
    /** Rows as objects: [{ brand: "Audi", n: 2 }, ...]. Read-only SQL over this page's tables. */
    async query(sql) {
      const r = await call("query", { sql: String(sql) });
      return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
    },
    /** The raw result: { columns, rows, truncated }. */
    queryRaw: (sql) => call("query", { sql: String(sql) }),
    /** Draw a chart spec (like a graite:chart fence) or an ECharts option into an element. */
    chart(target, spec) {
      const node = el(target);
      // A Graite spec may itself have a `series` field (the column to split by), so only an
      // array/object series without `source`/`sql` identifies a raw ECharts option.
      const raw = !!(
        spec &&
        !spec.source &&
        !spec.sql &&
        ((spec.series && typeof spec.series !== "string") ||
          spec.xAxis ||
          spec.yAxis ||
          spec.dataset)
      );
      let entry = charts.get(node);
      if (!entry) {
        entry = { node };
        charts.set(node, entry);
        resize.observe(node);
      }
      entry.spec = spec;
      entry.raw = raw;
      if ((spec.type || "bar") !== "number" && !entry.instance)
        entry.instance = echarts.init(node, undefined, { renderer: "canvas" });
      draw(entry);
      return entry.instance;
    },
    /** Call `cb` when a table this page reads changes (charts made here redraw on their own). */
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    page: () => call("page"),
    theme: () => theme,
    /** Format a number like the app: graite.format(1234.5, "EUR") -> "€1,234.50". */
    format(value, currency) {
      const kind = currency
        ? String(currency).startsWith("currency:")
          ? String(currency)
          : `currency:${currency}`
        : "number";
      return formatValue(value, kind);
    },
  });

  applyTheme();
  document.addEventListener("DOMContentLoaded", () => {
    resize.observe(document.body);
    reportHeight();
  });
  parent.postMessage({ graite: 1, event: "ready" }, "*");
})();
