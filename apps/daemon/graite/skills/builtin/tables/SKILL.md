---
name: tables
description: Read, query and change data tables — CSV files in a page's _data folder shown by graite:table blocks — with read_tables, run_query_ro and propose_rows.
---

# Data tables

A data table is a CSV file in a page's `_data/` folder, for example
`Projects/Atlas/_data/expenses.csv`. Every row has a stable `id`. The page shows it with a
` ```graite:table ` block. This is different from a board or table **of pages** (a
`graite:view` fence over child pages — see the page-views skill).

## Read

Call `read_tables(page_path)` first. For each table it returns the `path`, the `sql_name`
to use in queries, the columns with their types and select options, the row count and a few
rows with their ids.

## Query

`run_query_ro(page_path, sql)` runs one read-only `SELECT` (a `WITH … SELECT` is fine):

```sql
SELECT category, sum(amount) AS total FROM expenses GROUP BY category ORDER BY total DESC
```

- Tables on `page_path` use their short name (`expenses`); tables of other pages use their
  quoted path without `_data` and `.csv` (`"Projects/Atlas/expenses"`).
- `pages(path, title, parent_path, created, updated, tags)` and
  `page_props(path, name, value)` hold the pages in scope and their typed properties:

  ```sql
  SELECT p.title, e.amount FROM pages p
  JOIN page_props s ON s.path = p.path AND s.name = 'Status' AND s.value = 'Active'
  JOIN "Projects/Atlas/expenses" e ON e.project = p.title
  WHERE p.path LIKE 'Projects/%'
  ```

- Multi-select cells read as text like `a; b`. Dates are ISO text (`2026-10-02`), so they sort
  and compare as text. Checkboxes are 1 or 0. Currency and percentage are plain numbers.
- At most 200 rows come back; aggregate in SQL rather than reading everything.

## Change rows

`propose_rows(table_path, ops, summary)` with ops such as:

```json
[
  {"op": "insert", "values": {"date": "2026-10-02", "description": "Taxi", "amount": 30, "category": "Travel"}},
  {"op": "update", "id": "0190c3…", "values": {"amount": 32.5}},
  {"op": "delete", "id": "0190c4…"}
]
```

- Use column names exactly as `read_tables` lists them; a new column needs the user.
- Give values in the column's type: numbers as numbers, dates as `YYYY-MM-DD`, checkboxes as
  `true`/`false`, multi-select as a list, select and status as one of the listed options.
- Get ids from `read_tables` or `run_query_ro` (`SELECT id, … FROM expenses WHERE …`).
- Put related changes in one call with one summary. The page's AI settings decide whether
  it applies at once or waits for the user's review; say which in your answer.

## Show a table on a page

A table block is a fence on the page (propose_edit or propose_append):

````markdown
```graite:table
source: _data/expenses.csv
filter: category = "Travel" and amount > 100
sort: date desc
columns: [date, description, amount]
```
````

`filter` uses `=`, `!=`, `<`, `>`, `<=`, `>=`, `contains`, `in [a, b]`, `is empty`,
`is not empty`, `and`, `or`, `not` and parentheses; quote text with spaces and back-quote
column names with spaces (`` `Project name` ``).
