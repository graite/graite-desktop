---
name: page-views
description: Build a board (kanban), table or list of pages — the parent's graite:view fence, the card pages under it, and the Status property that makes the columns.
---

# Boards, tables and lists

A board is **not** Markdown headings. Writing `## To do` / `## Done` produces a page that
looks like a board to you and is plain text to Graite: it cannot be dragged, filtered or
counted, and the user cannot add a card to it.

A real board is two things:

1. A **parent page** whose body holds one ` ```graite:view ` fence.
2. Its **direct child pages** — one per card. Each card's own typed properties hold its
   values. Nothing about a card lives in the parent.

## Step 1 — the parent page

Read the requested page and list its direct children first. For “a board in Todos”, Todos
itself is the parent: append or edit its body, **do not create Todos/Kanban Board**. Preserve
its other content. Only create a separate board page when explicitly requested; then add
a `[[returned/path]]` link on the original page so the user can find it.

Put the fence at the end of the body. `group` names the property the columns come from.
Store field definitions under `settings.fields` so the columns and fields exist even with
zero cards. Here is a todo board with a backlog, priority, and project:

````
```graite:view
view: kanban
group: Status
show: [Priority, Project]
settings:
  fields:
    - name: Status
      type: status
      options: [Backlog, To do, In progress, Done]
    - name: Priority
      type: single_select
      options: [High, Medium, Low]
    - name: Project
      type: text
```
````

`view:` is `kanban`, `table` or `list`. The only other keys are `group`, `show` and
`settings` — **any other key turns the whole block into plain text**, so do not invent
`groupBy`, `columns`, `fields` or `options`.

If the page already exists, `propose_edit` or `propose_append` the fence onto it. If it does
not, `propose_create` it. Either way, keep the `path` the tool gives back.

## Step 2 — the cards

Use the user's actual todos from the page or conversation, one card per todo. Do not stop
after creating the view when tasks were supplied. If there are no tasks, leave the configured
columns empty and ask which tasks to add; never invent tasks or create pages for columns.
Reuse existing child pages and set their fields with propose_properties instead of duplicating
them. Read results after each dependent action; use the exact returned paths.

One `propose_create` per card, with `parent_path` set to the parent's path and the values in
`properties`:

```json
{
  "title": "Task supplied by the user",
  "parent_path": "Todos",
  "summary": "First card on the new board",
  "body": "",
  "properties": [
    {"name": "Status", "type": "status", "options": ["Backlog", "To do", "In progress", "Done"], "value": "Backlog"},
    {"name": "Priority", "type": "single_select", "options": ["High", "Medium", "Low"], "value": null},
    {"name": "Project", "type": "single_select", "options": [], "value": null}
  ]
}
```

You may propose the cards in the same turn as the parent, before the user has accepted it.
Examples describe the format only. Never copy sample tasks or invent project names.

Fields on an existing board: read the board first. read_page on the board or on one of its
cards returns `board_fields` (each field's name, type, options and how often each value is
used) and list_children shows each card's values. Reuse those exact names and options.
- Prefer `single_select` with options derived from the values already in use over free
  `text` for recurring attributes such as Project, Area or Owner.
- When a new entry clearly has a value no option covers (a new project the user named), set
  it as the value and list it in `options`; the option is added to the board.
- When a recurring attribute the user mentions has no field yet, propose that property, on
  the new card and with propose_properties on the existing cards that have a known value.
- Leave unknown values unset rather than guessing.
Afterwards, check list_children for applied pages or list_proposals for pending changes.
Report the location and distinguish applied changes from proposals awaiting review.

## Rules that decide whether it works

- The grouping property must be `type: status` or `type: single_select`. Nothing else can be
  a board's columns.
- Give **every** card the same `options`, in the same order. They are what the columns are.
- A card's `value` must be one of its own `options`.
- One card per *thing*, not one page per column. Columns come from the property, never from
  child pages named "To do".
- A card with no value for the grouping property lands in an untitled column. Set one.
- Properties only work on nested pages, so a card always has a parent.

## Changing a board that already exists

`list_children` the parent and `read_page` one card first, and copy its `options` exactly —
a near-miss set of options makes a second column instead of reusing the right one. Then:

- move a card between columns, or add a field to it: `propose_properties`
- add a card: `propose_create` with `parent_path` and `properties`
- switch the same pages between board, table and list: edit `view:` in the fence

## What not to do

- `## Backlog` / `## Open` headings with bullets under them — this is the failure this skill
  exists to prevent.
- `groupBy: Status` — the key is `group`.
- `view: gallery` or `view: timeline` — only `kanban`, `table` and `list` exist.
- Listing the card values on the parent page. They live on the cards.
