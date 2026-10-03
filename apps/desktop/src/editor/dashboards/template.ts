import { sourceFor, type TableColumn, type TableInfo } from "@/lib/tables";

const GROUPING = ["status", "single_select", "checkbox", "multi_select"];
const NUMERIC = ["number", "currency", "percent"];

interface DashboardItem {
  title: string;
  detail: string;
  spec: Record<string, string | number>;
}

function human(text: string): string {
  const words = text.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : text;
}

function html(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

/** JSON embedded in an inline script must not be able to spell `</script>`. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function first(table: TableInfo, types: string[]): TableColumn | undefined {
  return table.columns.find(
    (column) => types.includes(column.type) && column.name !== table.primary_key && !column.reverse,
  );
}

function metricItems(pagePath: string, tables: TableInfo[]): DashboardItem[] {
  const items: DashboardItem[] = tables.slice(0, 4).map((table) => ({
    title: `${human(table.name)} rows`,
    detail: human(table.name),
    spec: {
      source: sourceFor(pagePath, table),
      type: "number",
      title: `${human(table.name)} rows`,
    },
  }));
  // A page with one or two tables benefits more from useful measures than four near-empty
  // placeholders. The chart endpoint supplies the column's number/currency/percent format.
  for (const table of tables) {
    const number = first(table, NUMERIC);
    if (!number) continue;
    for (const [aggregate, label] of [
      ["avg", "Average"],
      ["max", "Highest"],
    ] as const) {
      if (items.length >= 4) break;
      items.push({
        title: `${label} ${human(number.name).toLocaleLowerCase()}`,
        detail: human(table.name),
        spec: {
          source: sourceFor(pagePath, table),
          type: "number",
          y: `${aggregate}(${number.name})`,
          title: `${label} ${number.name}`,
        },
      });
    }
    if (items.length >= 4) break;
  }
  return items.slice(0, 4);
}

function chartItems(pagePath: string, tables: TableInfo[]): DashboardItem[] {
  const items: DashboardItem[] = [];
  for (const table of tables) {
    const source = sourceFor(pagePath, table);
    const group =
      GROUPING.map((type) => first(table, [type])).find(Boolean) ?? first(table, ["relation"]);
    if (group && items.length < 2) {
      items.push({
        title: `${human(table.name)} by ${human(group.name).toLocaleLowerCase()}`,
        detail: `Distribution across ${human(group.name).toLocaleLowerCase()}`,
        spec: {
          source,
          type: ["multi_select", "relation"].includes(group.type) ? "bar" : "donut",
          x: group.name,
          sort: "y desc",
          limit: 10,
        },
      });
    }
    const number = first(table, NUMERIC);
    const date = first(table, ["date"]);
    const label =
      table.columns.find((column) => column.name === table.label_column) ?? first(table, ["text"]);
    if (number && (date || label) && items.length < 2) {
      const x = date ? `month(${date.name})` : label!.name;
      items.push({
        title: date
          ? `${human(number.name)} over time`
          : `${human(number.name)} by ${human(label!.name).toLocaleLowerCase()}`,
        detail: date ? `Monthly ${human(number.name).toLocaleLowerCase()}` : human(table.name),
        spec: {
          source,
          type: date ? "line" : "bar",
          x,
          y: number.name,
          sort: date ? "x asc" : "y desc",
          limit: 10,
        },
      });
    }
    if (items.length >= 2) break;
  }
  // A table without typed fields can still say something useful.
  if (!items.length && tables[0]) {
    const table = tables[0];
    const label = first(table, ["text"]);
    if (label)
      items.push({
        title: `${human(table.name)} overview`,
        detail: `Rows by ${human(label.name).toLocaleLowerCase()}`,
        spec: {
          source: sourceFor(pagePath, table),
          type: "bar",
          x: label.name,
          sort: "y desc",
          limit: 10,
        },
      });
  }
  return items;
}

/**
 * A polished, live starter dashboard generated from the page's real table schemas. Counts,
 * useful numeric summaries and up to two charts redraw through `graite.chart` whenever the
 * underlying CSV data changes. The result stays ordinary, editable HTML.
 */
export function starterDashboard(title: string, pagePath: string, tables: TableInfo[]): string {
  const own = tables.filter(
    (table) => table.page_path === pagePath || table.page_path.startsWith(pagePath + "/"),
  );
  const metrics = metricItems(pagePath, own);
  const charts = chartItems(pagePath, own);
  const noun = own.length === 1 ? "table" : "tables";
  const subtitle = own.length
    ? `Live overview from ${own.length} ${noun}`
    : "Add a table to this page to populate the dashboard";
  const metricMarkup = metrics
    .map(
      (item, index) => `
      <article class="metric-card">
        <div class="metric-kicker">${html(item.detail)}</div>
        <div class="metric" id="metric-${index}" aria-label="${html(item.title)}"></div>
      </article>`,
    )
    .join("");
  const chartMarkup = charts
    .map(
      (item, index) => `
      <article class="chart-card">
        <header>
          <div>
            <h2>${html(item.title)}</h2>
            <p>${html(item.detail)}</p>
          </div>
          <span class="live"><i></i> Live</span>
        </header>
        <div class="chart" id="chart-${index}" aria-label="${html(item.title)}"></div>
      </article>`,
    )
    .join("");
  const empty = own.length
    ? ""
    : `<div class="empty"><strong>No data yet</strong><span>Create or import a table on this page, then make a new dashboard.</span></div>`;

  return `<!doctype html>
<html>
<head>
<title>${html(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 4px 2px 10px; color: var(--graite-fg); }
  .dashboard-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 0 2px 18px; }
  .eyebrow { margin: 0 0 5px; color: var(--graite-muted); font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 0; font-size: 22px; line-height: 1.2; letter-spacing: -.035em; }
  .subtitle { margin: 5px 0 0; color: var(--graite-muted); font-size: 12px; }
  .updated { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; color: var(--graite-muted); font-size: 11px; }
  .updated::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--graite-color-2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--graite-color-2) 14%, transparent); }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .metric-card, .chart-card { border: 1px solid color-mix(in srgb, var(--graite-border) 86%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--graite-bg) 97%, var(--graite-accent)); box-shadow: 0 1px 2px rgb(0 0 0 / 3%), 0 10px 28px -26px rgb(0 0 0 / 28%); }
  .metric-card { min-height: 104px; padding: 15px 16px 13px; }
  .metric-kicker { margin-bottom: 9px; color: var(--graite-muted); font-size: 10px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; }
  .metric { min-height: 49px; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 10px; margin-top: 10px; }
  .chart-card { min-width: 0; padding: 16px 16px 10px; }
  .chart-card header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .chart-card h2 { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: -.01em; }
  .chart-card p { margin: 3px 0 0; color: var(--graite-muted); font-size: 11px; }
  .live { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border-radius: 999px; background: var(--graite-accent); color: var(--graite-muted); font-size: 10px; }
  .live i { width: 5px; height: 5px; border-radius: 50%; background: var(--graite-color-2); }
  .chart { width: 100%; height: 270px; margin-top: 5px; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 180px; margin-top: 10px; border: 1px dashed var(--graite-border); border-radius: 14px; color: var(--graite-muted); text-align: center; }
  .empty strong { color: var(--graite-fg); font-size: 13px; }
  .empty span { max-width: 320px; margin-top: 4px; font-size: 12px; }
  [data-theme="dark"] .metric-card, [data-theme="dark"] .chart-card { box-shadow: 0 12px 30px -24px rgb(0 0 0 / 60%); }
  @media (max-width: 520px) {
    .dashboard-head { align-items: flex-start; flex-direction: column; margin-bottom: 14px; }
    .metrics { grid-template-columns: 1fr 1fr; }
    .charts { grid-template-columns: 1fr; }
    .chart { height: 240px; }
  }
</style>
</head>
<body>
  <header class="dashboard-head">
    <div>
      <p class="eyebrow">Dashboard</p>
      <h1>${html(title)}</h1>
      <p class="subtitle">${html(subtitle)}</p>
    </div>
    ${own.length ? `<span class="updated">Updates with your data</span>` : ""}
  </header>
  <section class="metrics">${metricMarkup}</section>
  <section class="charts">${chartMarkup}</section>
  ${empty}
<script>
  const METRICS = ${scriptJson(metrics.map((item) => item.spec))};
  const CHARTS = ${scriptJson(charts.map((item) => item.spec))};
  METRICS.forEach((spec, index) => graite.chart(\`#metric-\${index}\`, spec));
  CHARTS.forEach((spec, index) => graite.chart(\`#chart-\${index}\`, spec));
</script>
</body>
</html>
`;
}
