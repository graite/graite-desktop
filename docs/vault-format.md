# Vault format

The on-disk contract. Everything here must stay true when the vault is opened in Obsidian,
edited with vim, or committed to git. Graite never requires anything outside this spec to
open a vault; `.graite/` is rebuildable.

## 1. Folder rules

- A **vault** is any folder the user opens. Graite creates `.graite/` inside it on first open.
- A folder is a **page** if and only if it contains `page.md`.
- Folders whose name starts with `_` or `.` are **never pages**. They are reserved for
  per-page resources (`_assets`, `_data`, `_dashboards`, `_skills`) and tooling
  (`.graite`, `.obsidian`, `.git`).
- Child pages are **sibling folders** inside the page folder. Depth is unlimited.
- Child order is frontmatter `order` (float, ascending), then title (case-insensitive).
- Folder name is a **slug of the title** (`Meeting Notes 2026` → `Meeting Notes 2026` is kept
  as-is when filesystem-safe; only `/ \ : * ? " < > |` and leading dots are replaced).
  Rename = move folder + update `title` + rewrite wikilinks vault-wide.
- Loose `.md` files that are not `page.md` (e.g. a vault imported from Obsidian) are
  **imported on open**: `Foo.md` becomes `Foo/page.md` after an explicit confirmation dialog.
  Until confirmed, they are shown read-only under "Unconverted files".

```
MyVault/
  AGENTS.md                        # root instructions (optional)
  NAVIGATION.md                    # generated
  NAVIGATION-DEEP.md               # generated
  .graite/
    config.toml                    # vault settings
    index.sqlite                   # derived; safe to delete
    tables.sqlite                  # derived query cache of every _data/*.csv; safe to delete
    versions/<page-id>/<unix_ms>.md
    trash/<unix_ms>-<slug>/        # soft-deleted page folders, restorable
    chat/<conversation-id>/        # files attached to a chat, deleted with it
    skills/<name>/SKILL.md         # vault-level skills
  Projects/
    page.md                        # the "Projects" page
    AGENTS.md                      # instructions for everything under Projects/
    _assets/                       # files for this page only
    _data/expenses.csv             # a table: plain CSV with an `id` column
    _data/expenses.schema.json     # optional: column types, options, relations, order
    _dashboards/overview.html
    _skills/weekly-review/SKILL.md # page-level skill
    Atlas/
      page.md
      Roadmap/
        page.md
        _assets/<uuid>-gantt.png
```

Models are **per machine**, not per vault: `~/.graite/models/` (path overridable in the app
settings). `.graite/config.toml` only records which catalog ids the vault prefers.

## 2. `page.md`

```markdown
---
id: 018f3c2e-7a1b-7c3d-9e4f-0a1b2c3d4e5f
title: Roadmap
icon: 🗺️
created: 2026-09-14T10:02:11Z
updated: 2026-09-14T11:40:00Z
tags: [planning]
order: 2.0
aliases: [Plan, Timeline]
autonomy: propose
auto_apply_kinds: []
skills: [summarise, weekly-review]
model: default
live:
  objective: "Keep this page a current summary of ./Meetings/*"
  cron: "0 7 * * 1-5"
  last_run_at: 2026-09-12T07:00:04Z
---

# Roadmap

Body starts here. The H1 is optional; `title` in frontmatter is authoritative.
```

| Key | Type | Set by | Notes |
|---|---|---|---|
| `id` | uuidv7 | fileops, once | Stable across renames and moves. The index, versions and proposals key on it. |
| `title` | string | user | Display title. Folder name is derived from it. |
| `icon` | string | user | Emoji, or `lucide:<name>`. |
| `created`, `updated` | ISO-8601 UTC | fileops only | Clients never set `updated`; it is written on every fileops write. |
| `tags` | list | user | Obsidian-compatible. |
| `order` | float | user / UI | Sibling ordering. Floats allow insert-between without renumbering. |
| `aliases` | list | user | Extra names wikilinks may use; also used to resolve links after external renames. |
| `autonomy` | `auto-apply` \| `propose` \| `none` | user | Inherits from the nearest page or `AGENTS.md`, then vault config. Default `propose`. `none` means no AI updates at all and cannot be lifted by a nested page. |
| `auto_apply_kinds` | list of `append`, `create`, `edit`, `properties`, `rows`, `delete` | user | Only read when `autonomy: auto-apply`. `edit` also covers `properties` and `rows` (table row changes, D69). `move` is never auto-applied; `delete` only where listed explicitly (the assistant's memory root sets it, the settings dialog never offers it, D57). |
| `cloud` | `allowed` \| `local-only` | user | `local-only` keeps this page and everything below it out of cloud providers (Claude, OpenAI-compatible servers off this machine); such pages are left out of answers produced by a cloud model and the answer says so. Cannot be lifted by a nested page. |
| `instructions` | string | user | How this page and its subtree should be structured. Accumulates root to leaf: every ancestor's instructions apply, then this page's. |
| `skills` | list | user | Allowlist of skill names for this subtree. Omit = inherit. |
| `model` | catalog id or saved model id (`m_…`) | user | Override for this subtree. Saved models live app-wide (`~/.graite/connections.json`). Unavailable → default with a status event. |
| `live` | object | user + fileops | Live Note. `objective` + `cron` set by user; `last_run_at` written by the runner on success only. |

Frontmatter is parsed and serialized by the daemon (`python-frontmatter`) in a **fixed key
order** (the order above, unknown keys appended alphabetically) so diffs stay stable. The
editor receives `{frontmatter, body}` separately and never serializes YAML.

## 3. `AGENTS.md`

Free-form markdown instructions for every agent working in this folder or below. Optional
frontmatter with the same `autonomy`, `auto_apply_kinds`, `cloud`, `instructions`, `skills`,
`model` keys applying to the whole subtree. Collected root → leaf and concatenated; the leaf
wins on conflict except for the two locks (`autonomy: none`, `cloud: local-only`). The
resolver (`vault/policy.py`) reports which file set each effective value; the page settings
dialog shows inherited values with that source. These keys are written only through
`FileOps.set_ai_settings` (the AI settings endpoint), never by the editor's body save.

```markdown
---
autonomy: propose
skills: [summarise, meeting-notes]
---
# Instructions for Projects/

- Every project page keeps a `## Status` section at the top; update it, never remove it.
- Meeting notes go under `Meetings/` as `YYYY-MM-DD <topic>`.
- Write in English, tables for comparisons, no emoji in headings.
```

## 3b. `_agents/` and `_workflows/`

Definition folders next to `_skills/`, at the vault root or inside any page folder. An agent
file carries `name`, `description`, `scope`, `mode` (`ask`/`act`), `model`, `skills`,
`tools` and `schedule` (cron) in frontmatter and its instructions in the body; a workflow
file carries `name`, `description`, `schedule` and `steps` (`agent`, `instructions`,
`scope`). They are written by the Studio through `FileOps.write_definition` or by hand; they
are not pages and never appear in the sidebar.

One agent per vault may be the **personal assistant**: `assistant: true`, plus
`memory: <page id>` (the root of its memory pages, ordinary pages the user can read and edit)
`voice: {language, exaggeration, cfg, voice_id, reference, consent_at}` and `user_name` (what
it calls the user, used for the spoken greeting). `voice_id` points into the app-wide voice
library (`<app_dir>/voices/`, not vault content, so a cloned voice follows the user between
vaults); the older `reference`, a clip in the memory root's `_assets` honoured only together
with `consent_at`, still works and is never rewritten on open. Its body
uses the headings `## Personality`, `## Context`, `## Guidelines` and `## Goals`. The agent
editor preserves keys it does not manage. See `docs/design/voice-and-assistant.md`.

## 4. `NAVIGATION.md` and `NAVIGATION-DEEP.md`

Generated by the daemon (`vault/navigation.py`), written through fileops with frontmatter
`generated: true`. The editor opens them read-only; the indexer and watcher ignore them.

`NAVIGATION.md` — regenerated on any tree change, debounced 2 s:

```markdown
---
generated: true
updated: 2026-09-14T11:40:00Z
---
# Navigation

- [[Projects/page|Projects]] (2 children, updated 2026-09-14)
  - [[Projects/Atlas/page|Atlas]] (1 child, updated 2026-09-10)
    - [[Projects/Atlas/Roadmap/page|Roadmap]] (updated 2026-09-14)
- [[Journal/page|Journal]] (140 children, updated 2026-09-14)
```

`NAVIGATION-DEEP.md` — same tree; each entry is followed by a 1–2 sentence purpose summary.
Summaries live in the index (`pages.summary`, `pages.summary_hash`) and are produced by a
low-priority `summarize_page` job whenever `body_hash` changes. The file is rewritten when
any summary changes.

Agents get `NAVIGATION.md` in their system prompt (depth-limited around the current page,
about 3k tokens). `NAVIGATION-DEEP.md` is available through the `read_navigation(deep=True)`
tool.

## 5. Block encoding

Rule: **native markdown wherever Obsidian renders it. Fences only for config-only blocks.**

| Editor block | Markdown |
|---|---|
| Heading 1–3 | `#`, `##`, `###` (H4–H6 import as H3 with a level marker, export unchanged) |
| Paragraph, bold, italic, strike, code, link | CommonMark / GFM |
| Bullet, numbered, checklist, nested | GFM lists, `- [ ]` |
| Quote | `>` |
| Callout | `> [!note] Title` (Obsidian callout) |
| Toggle | Foldable callout: `> [!toggle]- Title` then the body lines prefixed with `> `. Obsidian renders it collapsed with a default icon. Toggle headings are deliberately not offered; only plain toggles. |
| Table | GFM table (no nested blocks inside cells) |
| Code | Fenced code with language |
| Divider | `---` |
| Page link (child page) | `[[Atlas]]` alone on its own line. Resolves to the child folder `Atlas/page.md`. |
| Page link (any other page) | `[[Projects/Atlas/Roadmap]]` alone on its own line: the full vault path, which Obsidian also resolves. |
| Inline wikilink | `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]` |
| Local audio / image / PDF | ```` ```graite:media ```` fence: `file` (stored name in the page's `_assets/`), `name`, `kind` |
| Image by URL | `![caption](https://…)` |
| Page view (table / board / list of child pages) | ```` ```graite:view ```` fence, see "Page properties and views" |
| Table (CSV in `_data/`) | ```` ```graite:table ```` fence, or `![[name.csv]]` alone on its line for the whole table; see §7 |
| Chart (over CSV tables) | ```` ```graite:chart ```` fence; see §8 |
| Dashboard | ```` ```graite:dashboard ```` fence (`src: _dashboards/x.html`); see §8 |
| Transcript (inline) | ```` ```graite:transcript ```` fence |
| Anything else (HTML, math, footnotes) | `rawMarkdown` block: verbatim, edited as text |

Fence bodies are YAML:

````markdown
```graite:table
source: _data/expenses.csv   # this page's _data/, a vault path, or a bare table name
view: table                  # table (board, calendar later)
filter: category = "Travel" and amount > 100
sort: date desc              # or a list: [-date, amount]
columns: [date, description, amount, category]
height: 480                  # optional, pixels
tabs:                        # optional: the view each other tab of the block keeps (D71)
  _data/people.csv:          # keyed like source:
    filter: age > 30
    sort: [-age]
    columns: [name, age]
```

```graite:dashboard
src: _dashboards/overview.html
height: 480
```
````

Unknown `graite:*` kinds render as a labeled code block in Graite and as a plain code block
everywhere else. Never break on unknown kinds.

## 6. Attachments

- Live in the page's own `_assets/`. Uploaded through the daemon (`POST /media/upload`),
  never written by the webview. Renaming or moving a page carries its `_assets/` along.
- Stored as `<32 hex>-<safe original name>`. The prefix makes every name unique, so files
  are never overwritten and the name alone identifies a file. The UI shows the original name.
- A page refers to a file with a ```` ```graite:media ```` fence; a transcript or OCR subpage
  links its source as `[name](../_assets/<file>)`. Obsidian shows the fence as a code block
  and follows the link.
- Read by the UI through the authenticated `GET /api/v1/media/file` (the webview turns the
  bytes into a blob URL); there is no custom URL scheme.
- `_assets/` holds what the user attached, nothing generated. Transcripts and OCR text become
  part of a page: a toggle under the file, or a new subpage. Generation never overwrites a
  page or an earlier result. (Old vaults may still contain `<uuid>-transcript.md` /
  `<uuid>-ocr.md` files from before D32; an old `graite:text` fence may still show one.)
- Removing a block from a page leaves its file in place. The page's **Attachments** list
  shows every file, marks those no page uses, and moves a file to `.graite/trash/` (D29).
  A file counts as used when its stored name appears in the `page.md` of its page or of a
  subpage.

## 7. Per-page data: `_data/` (D68)

A page's tables are CSV files in its `_data/` folder. The CSV is the truth; Graite queries a
derived SQLite copy in `.graite/tables.sqlite`, rebuilt from the files whenever they change.

```
Projects/Atlas/_data/
  expenses.csv             # RFC 4180, UTF-8, header row, a stable `id` column
  expenses.schema.json     # optional
  project_tags.csv         # a junction table (many-to-many with fields of its own)
```

- **Ids.** Every row has an `id` (uuidv7) that never changes, so edits, proposals and diffs
  address rows by id, not by position. A CSV without an `id` column (or with blank or repeated
  ids) is shown with temporary ids and a warning; Graite writes real ids on the first edit or
  when asked, never just because the table was opened. Tables created or imported in Graite
  get the column immediately; a new table starts with one empty row. The id column is always
  text, even when ids look like numbers.
- **Writing.** Only fileops writes table files (`write_table_rows`, `alter_table_columns`,
  `create_table`, `update_table_schema`), under the per-file lock, with a snapshot in
  `.graite/versions/tables/`. The file keeps its delimiter, line endings and BOM, and rows
  nobody edited keep their exact bytes. Editing a row somebody else changed meanwhile is a
  conflict for that row only. Agents never write rows: they file `rows` proposals on the
  table's page, which apply or wait for review by that page's AI settings (D69).
- **`<name>.schema.json`** (optional, hand-editable):

  ```json
  { "id": "0199…", "primary_key": "id", "display": "name", "display_secondary": "city",
    "order": ["id", "date", "amount"],
    "columns": {
      "amount":   { "type": "currency", "currency": "EUR", "width": 120 },
      "category": { "type": "single_select", "options": ["Travel", "Food"],
                    "colors": { "Travel": "blue", "Food": "orange" } },
      "state":    { "type": "status", "options": ["Todo", "Doing", "Done"] },
      "owner":    { "type": "relation", "table": "People/_data/people.csv",
                    "table_id": "0199…", "cardinality": "one" },
      "tasks":    { "type": "relation", "table": "tasks", "table_id": "0199…",
                    "reverse": "project" } } }
  ```

  Types are the page-property kinds plus two number formats: `text | number | currency |
  percent | single_select | multi_select | status | date | checkbox | url | email |
  relation` (older spellings `integer`, `boolean`, `select`, `multiselect`, `datetime` are
  still read). Without a schema file (or for columns it does not list) types are inferred from
  the data. A broken schema file is a warning, never a hidden table.
  - `currency` and `percent` cells are plain numbers (`12.5`, `25`); the column's `currency`
    (ISO code, default EUR) and the `%` are added on screen. `€12.50` and `25%` are still
    read when a file already holds them.
  - Select, multi-select and status options are the schema's `options` plus any other value
    found in the data; `colors` uses the page palette (gray, brown, orange, yellow, green,
    blue, purple, pink, red), defaulting like page properties (Done green, Blocked red, …).
    Renaming or deleting an option in Graite rewrites every row that holds it.
  - Changing a column's type edits only the schema file, never the CSV. Values that do not
    read as the new type stay as written; Graite counts them before the change and shows them
    in red until they are fixed.
  - `"wrap": true` on a text column shows long values on several lines.
  - `multi_select` cells hold values separated by `;`. In filters, `=`, `!=` and `in`
    match one whole value of the list; `contains` matches text.
- **Relations** (D71). A relation column holds links to rows of another table (or the same
  one): `[[<row id>|<label>]]`, several separated by a space, e.g.
  `[[0199a…|Acme BV]] [[0199b…|Beta]]`. The id is what the link means; the label is the
  target row's display value, there so the CSV reads well elsewhere. Graite shows the live
  value, rewrites the labels when the value is edited in Graite, and rewrites stale ones on
  request ("Refresh link labels"). `[[id]]` and bare ids separated by `;` are read too.
  - `table:` names the target (a name in the same `_data/`, or a vault path) and `table_id:`
    its schema `id`, which wins, so links survive moving or renaming pages and tables.
    `cardinality:` is `one` or `many` (default).
  - A **reverse column** (`"reverse": "<forward column>"`) lives in the target's schema only,
    never in its CSV: it lists the rows linking to each row, and editing it writes the forward
    cells in the other table. Each relationship is stored once.
  - Many-to-many needs no special table; when the relationship has fields of its own (role,
    hours), use a junction table with two `one` relations. (`via:` is read but unused.)
  - `display` names a row in pills, the picker and review cards (default: the first text,
    select or status column); `display_secondary` tells rows with the same name apart.
  - Deleting a row in Graite removes links to it. A link to a row that is gone (deleted
    outside Graite) is kept and flagged as broken; repeated ids are flagged and only get new
    ids when the user asks, never on a write.
- **Renaming** a table renames `<name>.csv` and `<name>.schema.json`; relation `table:` hints,
  fence `source:` values and `tabs:` keys, and `![[<name>.csv]]` embeds that meant it follow.
- **Views** are `graite:table` fences or `![[name.csv]]` embeds (§5). Filter, sort and
  visible columns live in the fence, so two pages can show the same table differently.
  Filters use a small language (`=`, `!=`, `<`, `>`, `contains`, `in [...]`, `is empty`,
  `and`/`or`/`not`, parentheses; `` `quoted names` ``) compiled to parameterized SQL.

## 8. Charts and dashboards (D72)

Both read the **tables a page may read**: its own `_data/` tables, its subpages', and every
table those link to through relations. Nothing else in the vault is visible to them.

**Charts** are ```` ```graite:chart ```` fences, drawn with ECharts from a compact spec the
daemon compiles to read-only SQL:

```graite:chart
title: Spend per owner city      # optional; made from the fields when absent
source: _data/expenses.csv       # like graite:table (or sql:, see below)
type: bar                        # bar | line | area | pie | donut | scatter | number
x: owner.city                    # column | relation (its rows' names) | relation.column | month(date)
y: amount                        # a number column (added up per label), count, avg(col), ... or a list
series: status                   # optional: split by a second field
filter: date >= "2026-01-01"     # the graite:table filter language
sort: y desc                     # x|y asc|desc
limit: 12
stacked: true
height: 320
palette: sunset                  # mono/grayscale (default) | vivid | ocean | sunset | forest | candy
```

- `y` is a number column (its values, added up per label: the value itself when each label
  is one row), `count`, or `count|sum|avg|min|max(col)`; a list draws one series each.
- Date buckets: `day()`, `week()`, `month()`, `quarter()`, `year()`.
- Relation paths follow one relation, in either direction (a reverse column works too).
- `sql:` replaces `source`/`x`/`y`/`series`/`filter`: one SELECT whose first column is the label
  and every other column a series.
- A fence with neither `source` nor `sql` is a chart still being set up.
- In the editor a new chart opens on "What do you want to see?": the user describes it, and the
  page's model returns a spec (`/api/v1/charts/ai`, checked against the data, never `sql`),
  or picks one of the suggested charts shown with live previews. An AI change to a chart is
  the user's own edit and can be undone (D73).

**Dashboards** are HTML files in the page's `_dashboards/` folder, for example
`Projects/Atlas/_dashboards/overview.html`, shown by a ```` ```graite:dashboard ```` fence
(`src: _dashboards/overview.html`, optional `height`; without one the frame fits its content).
They stay plain HTML and JS on disk. Adding an HTML block opens a dialog: the user can upload a
self-contained `.html` file, or ask the page's side chat to create a report/dashboard. AI creation
and revision use the ordinary `read_dashboard` / `propose_dashboard` review flow (D74).

- **The frame:** a sandboxed iframe (`allow-scripts` only, so an opaque origin, no access to
  the app or its storage) loaded from the daemon at `/api/v1/dashboards/frame` with a
  short-lived ticket. Its CSP allows no network at all.
- **What gets inlined:** the daemon inlines ECharts (`echarts`) and the bridge
  (`apps/daemon/graite/dashboards/static/bridge.js`) before the file's own scripts.
- **The bridge:** the dashboard asks the app over `postMessage`:

```js
const rows = await graite.query("SELECT status, count(*) AS n FROM tasks GROUP BY status");
graite.chart("#by-status", { source: "tasks", type: "donut", x: "status" }); // or an ECharts option
graite.onChange(() => redraw());   // a table the page reads changed
graite.format(1234.5, "EUR");      // "€1,234.50"
const page = await graite.page();  // { path, title }
const theme = graite.theme();      // { mode, colors }; also CSS --graite-fg, --graite-muted, ...
```

**Read-only SQL** (dashboards, `sql:` charts and the agent's `run_query_ro`):
- Tables are named by their name on the page (`expenses`) and by their quoted path elsewhere
  (`"Projects/Atlas/expenses"`).
- `pages` and `page_props` hold the pages in scope.
- `links(table, column, row_id, target_table, target_id)` holds every relation link, so joins
  through relations are plain SQL.

**Agents:**
- `propose_chart` adds a checked chart fence.
- `propose_dashboard` files a `dashboard` proposal. It writes the file (conflict-checked
  against the HTML the agent saw) and can add the block to the page; the user reviews it with
  a live preview.
- `read_dashboard` reads an existing one.

## 9. Skills

Anthropic skill format. A skill is a folder with a `SKILL.md`:

```markdown
---
name: weekly-review
description: Produce the Friday weekly review from this week's journal pages.
allowed-tools: [read_page, search_vault, propose_create]
---
1. Read every page under Journal/ dated this week.
2. ...
```

Resolution order: page `_skills/` → ancestors' `_skills/` → vault `.graite/skills/` →
built-ins. Built-ins ship with the daemon in `graite/skills/builtin/<name>/SKILL.md` and are
read first, so a vault skill of the same name replaces one. Graite ships `page-views`, which
teaches a model the `graite:view` contract below. The system prompt lists name + description only; the body is loaded on demand
through `load_skill(name)`. `allowed-tools`, when present, narrows the tool set further for
that turn (it can never widen it).

## 10. `.graite/config.toml`

```toml
[vault]
name = "MyVault"
ignore = ["node_modules", "*.tmp"]

[models]
chat = "qwen3-8b-q4"          # catalog ids; resolved on this machine
embedding = "qwen3-embedding-0.6b-q8"
vision = "qwen-vl-4b-q4"
speech = "whisper-large-v3-turbo"

[agents]
autonomy = "propose"           # vault-wide default

```

## Page properties and views

Nested pages can store a `properties` frontmatter list. Each entry contains a stable `id`,
`name`, `type`, `options`, and `value`. Types are `text`, `number` (finite JSON number or null), `single_select`, `multi_select`,
`date` (ISO date), `checkbox`, `email`, `url`, `media` (a page attachment filename), `status`,
`created`, and `updated`. The last two display the page's automatic timestamps and store
no user value. An optional `colors` map associates select/status option names with
`default`, `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, or `red`.
Existing option string lists remain compatible. Moving a page to the top level hides its properties without deleting them.

A `graite:columns` YAML fence contains `columns`, a list of 2–4 Markdown strings. Column
contents remain ordinary editor blocks, including lists, media, and nested toggles. Narrow
windows display the columns vertically.

A `graite:view` fence is a live view over the page's direct child pages, with values taken
from their frontmatter. Only `view`, `group` (or its legacy alias `field`), `show` and
`settings` are accepted, and an unrecognised key makes the whole block render as plain text —
so the daemon refuses a fence it knows the converter would drop (`vault/blocks.py`) rather than
let an agent file one. An agent sets the child pages' values with `propose_create(properties=…)`
or `propose_properties`; both go through `fileops.set_properties` like any other write.

```graite:view
view: kanban        # table | kanban | list
group: Status       # board only: the status/select property to group by; omitted when unset
show:               # per view kind: the order of the properties it displays
  kanban:
    - Priority
    - Due
settings:
  hide:             # per view kind: the properties it leaves out
    table: [Due]
```

Every view shows all of its pages' properties except the ones under `settings.hide`, so a
property added to one page appears on the board, table and list without further setup;
`show` only orders them, and properties it does not list follow in schema order (D66). A
board never repeats its grouping property on the cards.

The legacy `field` key is read as `group`, and a legacy bare list under `show` is read as
the list for the fence's own `view`; both are rewritten in the current form on the next save.
An unknown `view` value (for example the removed `timeline`) keeps the fence as raw Markdown.
Property definitions are per page; a view merges the definitions of its children by name
(options unioned, first color wins) and copies that merged definition onto a page when a
card is dropped into a column the page has no property for. Displaying a view never adds
properties automatically; the "Add a Status property" and "New property" actions do so
explicitly for every child page. A page inside a view offers the properties its siblings use
as empty rows, and filling one in adds that property to the page. Reordering cards inside a board column changes the same
`order` key the sidebar uses. Date values are stored as ISO dates and displayed as
"September 15, 2026".

Sidebar order is persisted in the existing `order` frontmatter key. Page moves retain IDs
and move the complete folder, rewrite resolved wikilinks, and reject descendant cycles or
colliding folder names. Both drag placement and the Move menu use the same operation.

### View controls and blank paragraphs

A `graite:view` fence may contain a `settings` mapping: `sort` (`field`, `direction`),
`filters` (AND rules with `field`, `op`, `value`), and `boards` keyed by grouping property
name. Each board stores its column `order` and `hidden` option names. `$title` refers to
page titles in sorting/filtering; an empty column name refers to ungrouped pages. Search
is temporary UI state. The per-view `show` lists define property order and `hide` lists the
properties a view kind leaves out.

Empty editor paragraphs serialize as `<!-- graite:empty -->`. This unobtrusive Markdown
comment preserves intentional blank blocks, including consecutive and trailing blocks,
without inserting visible placeholder text. Ordinary Markdown paragraph spacing is unchanged.

### Page AI settings scope

`ai_scope: page` applies the page's AI instructions and permissions only to itself.
`ai_scope: subtree` (also the default when absent) applies them to the page and its children.
Inherited `autonomy: none` and `cloud: local-only` cannot be loosened by descendants.
The page settings editor shows inherited instruction sources and can edit their original
page or shared `AGENTS.md` file. Models are chosen in chat or agents; legacy page `model`
fields no longer influence model selection.

### Fields on empty views

`settings.fields` on a `graite:view` fence stores optional property definitions (name, type,
options). This lets a board show its columns and fields before it contains cards. Card
values still live only on child pages. Creating a card copies these definitions with empty
values, then applies the chosen column and explicitly supplied values. Existing child
properties remain authoritative in the editor; definitions for missing fields supplement them.
A bare empty Status board displays Backlog, To do, In progress and Done until it has cards.
Opening a view never writes pages. See `fixtures/blocks/view-fields.md` for the portable form.
