---
name: tables
description: Read, query, create and change databases (data tables) — CSV files in a page's _data folder shown by graite:table blocks — with read_tables, run_query_ro, propose_rows, propose_columns and propose_table.
requires: [read_tables]
---

# Data tables

A data table is a CSV file in a page's `_data/` folder, for example
`Projects/Atlas/_data/expenses.csv`. Every row has a stable `id`. The page shows it with a
` ```graite:table ` block. This is different from a board or table **of pages** (a
`graite:view` fence over child pages — see the page-views skill).

## Where tables live

A table often lives on a parent page and is only *shown* on its subpages: the CRM template
keeps `CRM/_data/companies.csv` and shows it on `CRM/Companies` in the views "All companies"
and "By status". `read_tables(page_path)` lists the tables a page holds **or shows**;
`read_tables("")` lists every database in scope and the pages that show it.

## Read rows

`read_rows(table)` reads rows with their ids, 50 at a time (`next_offset` continues):

- `read_rows(table="companies")` or `read_rows(table="CRM/_data/companies.csv")`
- `read_rows(page_path="CRM/Companies", view="By status")`: the rows as that view shows them
- `filter`, `sort` and `search` narrow it; `id` returns one row and its document

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

- Use column names exactly as `read_tables` lists them. A value for a field the table does
  not have needs that field first: add it with `propose_columns`, then call `propose_rows`.
  Never squeeze several values into one text field such as `notes`.
- Formula columns (`"type": "formula"`, `read_only`) are computed from the row; never give
  them a value. They can be read, filtered and charted like any other column.
- Give values in the column's type: numbers as numbers, dates as `YYYY-MM-DD`, checkboxes as
  `true`/`false`, multi-select as a list, select and status as one of the listed options.
- Get ids from `read_tables` or `run_query_ro` (`SELECT id, … FROM expenses WHERE …`).
- Put related changes in one call with one summary. The page's AI settings decide whether
  it applies at once or waits for the user's review; say which in your answer.

## Change fields (columns)

`propose_columns(table_path, ops, summary)` with ops such as:

```json
[
  {"op": "add", "name": "Status", "type": "status", "options": ["Todo", "Doing", "Done"]},
  {"op": "add", "name": "Due", "type": "date"},
  {"op": "rename", "name": "notes", "to": "Description"},
  {"op": "set", "name": "Priority", "type": "single_select", "options": ["Low", "High"]},
  {"op": "delete", "name": "old_field"}
]
```

Types: text, number, currency, percent, single_select, multi_select, status, date, checkbox,
url, email. The `id` field cannot be changed. Deleting a field deletes its values; ask
first unless the user named the field. When the change waits for review, the new fields do
not exist yet: say so and continue after the user accepts.

## Make a new database

`propose_table(page_path, name, fields, summary, rows)` makes a database on an existing page
and shows it there. Give every field its type (and options for status and select fields),
and put the first rows in `rows`:

```json
{"page_path": "Business/Backlog", "name": "Backlog",
 "fields": [{"name": "Name"}, {"name": "Status", "type": "status", "options": ["Todo", "Doing", "Done"]},
            {"name": "Priority", "type": "single_select", "options": ["Low", "Medium", "High"]}],
 "rows": [{"Name": "Fix login", "Status": "Todo", "Priority": "High"}],
 "summary": "Backlog database"}
```

Use a database for many similar records with the same few fields (backlog items, tasks,
contacts, invoices). Use child pages with properties (the page-views skill) when each item
needs its own longer text. Check `read_tables` first and reuse a database that already fits.
For a database on a new page, create the page with `propose_create` first.

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
