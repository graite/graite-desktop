---
name: charts-and-dashboards
description: Chart a page's table data (graite:chart blocks via propose_chart) or build an HTML dashboard of tiles and charts (propose_dashboard), including data from related tables.
---

# Charts and dashboards

Both draw from the **tables a page may read**: its own (`_data/*.csv`), its subpages', and
every table those link to through relation columns. Call `read_tables` first to see the
tables, their columns and types, and which columns are relations (`links_to`).

## Chart or dashboard?

- **One chart** answering one question ("spend per month", "open tasks by owner"):
  `propose_chart`. It becomes a `graite:chart` block the user can tweak in a builder.
- **An overview** with several numbers and charts, custom layout or text: `propose_dashboard`.
  It is an HTML file in the page's `_dashboards/` folder, shown in a sandboxed frame.

## propose_chart

```json
{"page_path": "Garage", "summary": "Rating per car",
 "chart": {"source": "cars", "type": "bar", "x": "name", "y": "rating"}}
```

```json
{"page_path": "Garage", "summary": "Cars per owner city",
 "chart": {"source": "cars", "type": "donut", "x": "owners.city"}}
```

- `type`: bar (default), line, area, pie, donut, scatter, number (one big value).
- `x`: a column; a date bucket `day(col)`, `week(col)`, `month(col)`, `quarter(col)`,
  `year(col)`; a relation column (groups by the linked rows' names); or `relation.column` to
  group by a field of the linked rows. Relations work in both directions: a reverse column
  (listed with `reverse_of`) follows the links the other table holds.
- `y`: a number column (`rating`: its values, added up per label — the value itself when
  each label is one row), `count` (default), `count(col)`, `avg(col)`, `min(col)`,
  `max(col)`, `sum(col)`, or a list (several series). Only number fields can be added up.
- `series`: split by a second field. `stacked: true` stacks the parts.
- `filter`: the table filter language (`status = "Done" and amount > 100`).
- `sort`: `y desc` (default for categories), `x asc` (default for dates and lines).
- `palette`: colors, `mono`/grayscale (default), `vivid`, `ocean`, `sunset`, `forest` or
  `candy`. Stay grayscale unless color carries meaning; dashboards take it too:
  `graite.chart(el, {..., palette: "ocean"})`.
- `sql`: only when the fields cannot say it. The first column is the label, the others are
  series. Prefer the fields: people can change those charts themselves in the builder.

The tool draws the chart once before filing it, so a wrong column comes back as an error to
fix. Line charts suit dates (`month(date)`); pies suit a few parts of a whole (≤ 8 slices).

## propose_dashboard

The HTML runs with **no network**: never load scripts, fonts or images from URLs. ECharts is
already loaded as `echarts`, and `window.graite` gives the data:

| Call | What it does |
|---|---|
| `await graite.query(sql)` | Read-only SQL; rows as objects `[{brand: "Audi", n: 2}]`. |
| `graite.chart(el, spec)` | Draw a chart spec (same keys as propose_chart's `chart`) or an ECharts option. Specs redraw themselves when data changes. |
| `graite.onChange(fn)` | Run `fn` when a table the page reads changes (redraw tiles here). |
| `graite.format(n, "EUR")` | Format a number or an amount. |
| `graite.theme()` | `{mode, colors}`; prefer the CSS variables below. |

**SQL names**: a table on the page is named by its name (`cars`); a subpage's or linked
page's table by its quoted path (`"Garage/Fuel/fills"`). Relation cells are text like
`[[id|label]]`; to join through a relation use `links`:

```sql
SELECT o.city, count(*) AS cars
FROM cars c
JOIN links l ON l."table" = 'owners' AND l.column = 'car' AND l.target_id = c.id
JOIN owners o ON o.id = l.row_id
GROUP BY o.city
```

**Style**: use the theme variables so the dashboard fits light and dark mode:
`--graite-fg`, `--graite-muted`, `--graite-border`, `--graite-bg`, `--graite-accent`,
`--graite-color-1` … `--graite-color-9`. Default to grayscale and add color only when it
encodes meaning. Build a composed report: clear hierarchy, hairline rules, compact KPI headers,
aligned legend/detail rows, restrained labels and responsive sections. Avoid a grid of generic
rounded cards. Pie and donut sectors must be crisp (`borderRadius: 0`, `padAngle: 0`); time-series
charts use thin lines and subtle grid lines. Numbers can lead, while labels stay small and muted.

A complete example (tiles + two charts):

```html
<!doctype html>
<html>
<head>
<style>
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile, .card { border: 1px solid var(--graite-border); border-radius: 10px; padding: 14px 16px; }
  .value { font-size: 28px; font-weight: 700; }
  .label { color: var(--graite-muted); font-size: 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; margin-top: 12px; }
  .card h3 { margin: 0 0 8px; font-size: 13px; }
  .chart { height: 260px; }
</style>
</head>
<body>
  <div class="tiles">
    <div class="tile"><div class="value" id="cars">–</div><div class="label">Cars</div></div>
    <div class="tile"><div class="value" id="value">–</div><div class="label">Total value</div></div>
  </div>
  <div class="cards">
    <div class="card"><h3>Cars by status</h3><div class="chart" id="status"></div></div>
    <div class="card"><h3>Value by owner city</h3><div class="chart" id="city"></div></div>
  </div>
<script>
  async function tiles() {
    const [row] = await graite.query("SELECT count(*) AS n, sum(price) AS total FROM cars");
    document.querySelector("#cars").textContent = graite.format(row.n);
    document.querySelector("#value").textContent = graite.format(row.total, "EUR");
  }
  tiles();
  graite.onChange(tiles);
  graite.chart("#status", { source: "cars", type: "donut", x: "status" });
  graite.chart("#city", { source: "cars", type: "bar", x: "owners.city", y: "price" });
</script>
</body>
</html>
```

To change an existing dashboard, `read_dashboard` it first and send the whole new HTML with
the same `name`. The user reviews dashboards with a live preview before they are saved,
unless the page's AI settings apply changes directly.
