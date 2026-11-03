# Templates

Built-in templates (D77) live in `apps/daemon/graite/templates/builtin/<slug>/`. Each one is a
folder of ordinary vault files, so a template is written the same way a page is: Markdown,
CSV and JSON. Choosing one in the Templates gallery copies the folder into the vault with fresh
ids and today's dates.

## The shape every template follows (D81)

Templates follow the database model people know from Notion: **one database per subject**,
each on its own page, with records that **link** to each other instead of being copied, and a
**home page** that shows what matters now.

```
<slug>/
  template.json              name, description, icon, category, highlights, keep_rows
  root/
    page.md                  home: a "how it works" callout, the stats, one live view, links
    _dashboards/<name>.html  read-only stats (HTML with `const QUERIES = {...}`)
    _data/<table>.csv        the records (";"-separated, an `id` column)
    _data/<table>.schema.json  column types, relations, how links show, document template
    _data/<table>/<id>.md    optional: a record's own notes document
    <Database>/page.md       one per table (Deals, Companies, Weeks…): its views as tabs
    <Guide>/page.md          any other pages (a playbook, a checklist)
```

1. **The tables live in the home page's `_data/`.** The dashboard reads them by name
   (`SELECT ... FROM deals`); database pages and the home view show them by name
   (`source: deals` finds the nearest page up that has them).
2. **Each table has one database page**, named after what it holds. Its `graite:table` fence
   has `views:` (D79), all of the same table: a `table`, a `board` (grouped by a status or
   select field) or a `list`, each with its own filter, sort and the fields it shows. A line
   above the block says what the database is for.

   ```yaml
   views:
     - name: Pipeline
       source: deals
       view: board
       group: stage
       show: [company, value, expected_close]
     - name: All deals
       source: deals
       view: table
   ```

3. **Records link to each other with relation fields** (D71), so a record exists once: a goal
   that spans several weeks is one goal, linked from each week. A link field shows in a
   record's panel or page as pills, or as its own collapsible list when it has more than three
   links. To always show it as a list with chosen fields, give its schema entry a `panel` (D80):

   ```json
   "deals": { "type": "relation", "table": "deals", "table_id": "{{table:deals}}",
              "reverse": "company", "panel": { "as": "list", "show": ["stage", "value"] } }
   ```

   This is how a company lists its deals and contacts, a goal its weeks and priorities, a
   meeting its action items: an activity log is simply one more table that links to what it is
   about.
4. **Records that need notes get a document template.** A meeting or a week is a record, not a
   copied page; its schema's `document_template` gives every new record's document its
   headings (Agenda / Notes / Decisions, or Focus / Wins / Lessons / Next week):

   ```json
   "document_template": "## Agenda\n\n1. \n\n## Notes\n\n## Decisions\n\n- "
   ```

5. **Home shows what matters now**: a short callout, the stats dashboard, **one live view**
   (a `graite:table` with a single view, e.g. the pipeline board or open action items, which
   can be edited in place) and a `## Databases` section linking each database page. Dashboards
   only read; editing happens in the views and on the records.

**Making your own** works the same way, from the slash menu: **/Database** (a new database in
this page), **/Database page** (on its own subpage), **/Linked view of a database** (show one that
exists; this page's and its top-level page's databases are listed first), and **Fields → Link to
another database** to connect two. **/Subpages as table, board or list** is something else: it
shows the page's child pages and their properties, not a database.

## Placeholders

Files are copied with these filled in, so every use gets its own ids and current dates:

| Placeholder | Becomes |
| --- | --- |
| `{{id:key}}` | a new row id, the same everywhere `key` is used (rows, links); in file names write `{{id=key}}`, as Windows forbids `:` |
| `{{table:name}}` | a new table id (`schema.json` `id`, relation `table_id`) |
| `{{page:key}}` | the path of the page whose frontmatter has `template_key: key` |
| `{{date:-30}}`, `{{month:-2}}` | a date relative to today (YYYY-MM-DD) |
| `{{quarter:0}}`, `{{week:0}}` | `2026 Q4`, `2026 W45` |
| `{{monday:-1}}` | the Monday of a week relative to this one (YYYY-MM-DD) |
| `{{title}}` | the title the user gave the top page |

A page with `template_sample: true` in its frontmatter, and the rows of tables not named in
`keep_rows`, are left out when the user turns off example data.

## Checking a template

`apps/daemon/tests/test_templates.py` makes every template in a fresh vault and checks the shape
(home with a dashboard, one live view and links to every database page; each database page's
views read one table; each table has exactly one database page), that its tables load without
warnings, every view's table, filter and fields exist, boards group by a
status or select field, record documents belong to existing rows, and every dashboard query
runs. `packages/md-convert/src/templates.test.ts` checks that every page opens in the editor
unchanged.
