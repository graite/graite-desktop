import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Wand2 } from "lucide-react";
import * as echarts from "echarts/core";
import { charts, type ChartData, type ChartSpec } from "@/lib/charts";
import { tables as tablesApi, type TableInfo } from "@/lib/tables";
import { ChartAI } from "./ChartAI";
import { chartTables } from "./ChartBuilder";
import { buildOption, formatNumber, type ChartColors } from "./option";
import { EMPTY_CHART, specToProps, toSpec, type ChartProps } from "./spec";
import { nameField, numberFields, suggestions, type Suggestion } from "./suggest";

/** A small live preview of one suggestion, drawn from the real data. */
function Thumb({
  pagePath,
  props,
  colors,
}: {
  pagePath: string;
  props: ChartProps;
  colors: ChartColors;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ChartData | null>(null);
  const spec = useMemo(() => JSON.stringify(toSpec(props)), [props]);
  const type = props.type || "bar";
  useEffect(() => {
    let live = true;
    charts
      .data(pagePath, JSON.parse(spec) as ChartSpec)
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [pagePath, spec]);
  useLayoutEffect(() => {
    if (!box.current || !data || type === "number") return;
    const chart = echarts.init(box.current, undefined, { renderer: "canvas" });
    chart.setOption(buildOption(type, data, colors, { mini: true, palette: props.palette }));
    return () => chart.dispose();
  }, [data, colors, type, props.palette]);
  if (type === "number")
    return (
      <div className="chart-thumb chart-thumb-number">
        <span>{data ? formatNumber(data.value, data.format ?? "number", true) : "…"}</span>
      </div>
    );
  return <div ref={box} className="chart-thumb" />;
}

/**
 * Where a new chart starts: describe it to AI, or pick one of the charts the page's tables
 * suggest, each shown with its real data. The builder is one link away.
 */
export function ChartStart({
  pagePath,
  palette,
  colors,
  onPick,
  onBuild,
}: {
  pagePath: string;
  palette: string;
  colors: ChartColors;
  onPick: (props: ChartProps, message?: string) => void;
  onBuild: () => void;
}) {
  const [all, setAll] = useState<TableInfo[] | null>(null);
  useEffect(() => {
    tablesApi
      .list()
      .then(setAll)
      .catch(() => setAll([]));
  }, []);
  const readable = useMemo(() => (all ? chartTables(pagePath, all) : []), [pagePath, all]);
  const ideas: Suggestion[] = useMemo(() => {
    if (!all) return [];
    const out: Suggestion[] = [];
    for (const table of readable)
      for (const idea of suggestions(pagePath, table, all))
        if (out.length < 5 && !out.some((o) => o.label === idea.label))
          out.push(
            readable.length > 1 ? { ...idea, label: `${idea.label} · ${table.name}` } : idea,
          );
    return out;
  }, [pagePath, readable, all]);
  // Example requests in the words of this page's data.
  const examples = useMemo(() => {
    const table = readable[0];
    if (!table || !all) return [];
    const n = numberFields(table, all)[0]?.key;
    const name = nameField(table);
    const group = table.columns.find((c) => ["status", "single_select"].includes(c.type))?.name;
    return [
      n && name ? `${n} per ${name}, highest first` : null,
      group ? `${group} as a donut` : null,
      n && group ? `average ${n} by ${group}` : null,
    ].filter((x): x is string => !!x);
  }, [readable, all]);

  if (all && !readable.length)
    return (
      <div className="chart-start">
        <p className="chart-start-empty">
          Add a table to this page first: charts draw from the page's tables.
        </p>
      </div>
    );

  const pick = (patch: Partial<ChartProps>, message?: string) =>
    onPick({ ...EMPTY_CHART, palette, ...patch }, message);

  return (
    <div className="chart-start">
      <div className="chart-start-head">
        <Sparkles size={15} />
        <span>What do you want to see?</span>
      </div>
      <ChartAI
        pagePath={pagePath}
        autoFocus
        placeholder="Describe a chart… e.g. rating per car, highest first"
        ideas={examples}
        onResult={(spec, message) => onPick(specToProps(spec, { palette }), message)}
      />
      {ideas.length > 0 && (
        <>
          <div className="chart-start-label">Or start from one of these</div>
          <div className="chart-start-grid">
            {ideas.map((idea) => (
              <button
                key={idea.label}
                type="button"
                className="chart-card"
                onClick={() => pick(idea.patch)}
              >
                <Thumb
                  pagePath={pagePath}
                  props={{ ...EMPTY_CHART, palette, ...idea.patch }}
                  colors={colors}
                />
                <span>{idea.label}</span>
              </button>
            ))}
            <SurpriseCard pagePath={pagePath} palette={palette} onPick={onPick} />
          </div>
        </>
      )}
      <button type="button" className="chart-start-build" onClick={onBuild}>
        Build it yourself
      </button>
    </div>
  );
}

/** Let AI pick the most telling chart for the page's data. */
function SurpriseCard({
  pagePath,
  palette,
  onPick,
}: {
  pagePath: string;
  palette: string;
  onPick: (props: ChartProps, message?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <button
      type="button"
      className="chart-card chart-card-surprise"
      disabled={busy}
      title={error || undefined}
      onClick={() => {
        setBusy(true);
        setError("");
        charts
          .ai(pagePath, "Pick the single most insightful chart for this data.")
          .then(({ spec, message }) => onPick(specToProps(spec, { palette }), message))
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <div className="chart-thumb chart-thumb-surprise">
        <Wand2 size={22} className={busy ? "chart-ai-spin" : ""} />
      </div>
      <span>{busy ? "Thinking…" : error ? "Needs a model — see Settings" : "Surprise me"}</span>
    </button>
  );
}
