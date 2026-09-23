# Editor round-trip: markdown ↔ BlockNote

The riskiest part of Graite. A Notion-style block editor over plain markdown only works if
markdown → blocks → markdown is lossless for everything the vault contains, and the file
on disk is never rewritten by accident.

## 1. Why we own the converter

- BlockNote's built-in `blocksToMarkdownLossy` / `tryParseMarkdownToBlocks` are explicitly
  lossy and cannot represent wikilinks, callouts, embeds or `graite:` fences.
- Storing BlockNote JSON in a sidecar and exporting markdown makes markdown second-class,
  breaks edits made in Obsidian, and breaks the "files are the product" principle.
- The review queue works on text diffs. Lossy conversion would produce noise diffs on every
  save and make proposals unreviewable.

So `packages/md-convert` (TypeScript) owns both directions and is tested with golden files.

## 2. Pipeline

```
markdown ──remark-parse + remark-gfm + remark-frontmatter──▶ mdast
       ◀──mdast-util-to-markdown (pinned options)──────────
mdast ──custom extensions: wikilink, callout, graiteFence──▶ enriched mdast
enriched mdast ◀──toBlocks / fromBlocks──▶ BlockNote PartialBlock[]
```

Libraries: `unified`, `remark-parse`, `remark-gfm`, `remark-frontmatter`, `mdast-util-to-markdown`,
`micromark` extension API for `wikilink` (`[[target|alias]]`, `![[embed]]`, `[[page#heading]]`),
a post-pass for `callout` (blockquote whose first paragraph matches `[!type][+-]? title`), and a
post-pass `graiteFence` that reinterprets `code` nodes with `lang` starting `graite:` and parses
the YAML body (`yaml` package).

Serializer options are pinned and never changed without a migration note:
`bullet: "-"`, `emphasis: "_"`, `strong: "*"`, `fences: true`, `listItemIndent: "one"`,
`rule: "-"`, `incrementListMarker: true`.

Frontmatter is **not** handled here. The daemon splits `page.md` into `{frontmatter, body}`
and the editor only sees the body.

## 3. Mapping

| mdast | BlockNote block / inline |
|---|---|
| `heading` depth 1–3 | `heading` level 1–3 |
| `heading` depth 4–6 | `heading` level 3 with `props.mdLevel = 4..6` (exported back at original depth) |
| `paragraph` | `paragraph` |
| `list` / `listItem` (`ordered`, `checked`) | `bulletListItem` / `numberedListItem` / `checkListItem`; nested lists → `children` |
| `blockquote` | `quote` |
| `blockquote` matching callout syntax | custom `callout` block `{type, title, folded: null|true|false}`; `[!toggle]-` maps to the Toggle UI |
| `code` | `codeBlock` with `language` |
| `code` with `lang = graite:<kind>` | custom block per kind: `dbview`, `dashboard`, `transcript`; YAML fields in `props`; unknown kind → `graiteUnknown` (labeled code) |
| `image` (`![alt](url)`) | `image` with `url` |
| `embed` (`![[file]]`) | `image` / `audio` / `video` / `pdf` / `file` by extension, `url = vault://<vault-id>/<path>` |
| `table` (GFM) | `table` (cells are inline content only; block content inside cells is not supported and is flagged) |
| `thematicBreak` | custom `divider` block |
| `html`, `footnoteDefinition`, `math`, anything unmapped | custom `rawMarkdown` block: verbatim source, rendered monospace, editable as text |
| inline `strong`, `emphasis`, `delete`, `inlineCode`, `link` | styles / `link` |
| inline `wikilink` | custom inline content `wikilink {target, alias, heading}` |
| `paragraph` containing a single `wikilink` and nothing else | `pageLink` block (renders as Notion-style page row; exports as `[[Child]]` on its own line) |

The `rawMarkdown` block is what makes the converter lossless: anything we cannot model
survives byte-for-byte and can still be edited as text.

## 4. Tests

- **Golden fixtures**: `packages/md-convert/fixtures/*.md`. For every fixture,
  `toMarkdown(toBlocks(md)) === canonical(md)` where `canonical` is the pinned serializer over
  the parsed mdast. Fixtures include real pages from Obsidian vaults (callouts, nested
  checklists, tables, embeds, dataview blocks, math, HTML comments).
- **Property test** with `fast-check`: random documents built from the block grammar must
  round-trip exactly.
- **Idempotence**: `canonical(canonical(md)) === canonical(md)`.

## 5. Canonicalization policy

- Graite **never rewrites a file just by opening it.**
- On the first save of a file Graite did not write, formatting normalizes once. If the
  normalization diff exceeds a threshold (default 5% of lines), the UI shows a
  "Reformatted on save" notice with a diff link. This happens once per file.
- Files with `generated: true` frontmatter open read-only.

## 6. Save and conflict protocol

```
GET  /pages/{path}            → { frontmatter, body, hash }
PUT  /pages/{path}            ← { body, base_hash }
                              → 200 { hash }            (applied)
                              → 409 { disk_body, hash } (base_hash != disk)
WS   /events                  ← file_changed { path, hash, actor }
```

- The editor keeps `baseHash` from the last successful load or save.
- Saves are debounced 600 ms after the last change and serialized (never two in flight).
- The daemon's watcher (`watchfiles`) emits `file_changed`. Fileops records its own writes in
  `recent_self_writes: dict[path, hash]` so the editor ignores echoes of its own saves.
- On `file_changed` for the open page:
  - **Editor not dirty** → reload silently, restore selection by block index.
  - **Editor dirty** → 3-way merge (`node-diff3`) of `base` (last loaded), `mine` (editor
    markdown), `theirs` (disk). Clean merge → apply into editor, `baseHash = theirs`. Conflict
    → banner "Changed on disk" with **Keep mine** / **Take disk** / **Show diff**; no save until
    resolved.
- Guard: `syncingFromDiskRef` — while the editor is being updated programmatically (reload,
  merge, proposal apply) `onChange` must not schedule a save. Easy to get wrong.

## 7. Fileops contract (daemon, single writer)

```python
async def write_page(path, body, *, base_hash=None, frontmatter_patch=None, actor, reason) -> WriteResult
async def create_page(parent_path, title, *, body="", actor) -> Page
async def move_page(path, new_parent_path, new_title=None, *, actor)      # rewrites wikilinks vault-wide
async def trash_page(path, *, actor) / restore(trash_id)
async def write_attachment(page_path, filename, stream, *, actor) -> AttachmentRef
async def db_exec(page_path, sql, params=(), *, actor)
```

Every write: acquire per-path `asyncio.Lock` → verify `base_hash` (if given) → snapshot the
old file to `.graite/versions/<id>/<ms>.md` when the body differs → set `updated` → atomic
write (`tmp` in the same directory + `os.replace`) → update the index synchronously →
append an `activities` row → publish `file_changed`. No other module opens vault files for
writing; a lint rule enforces it (`open(..., "w")` and `Path.write_*` are banned outside
`vault/fileops.py`).

## 8. Editor features carried over from the prototype

- Slash-menu **"Page" item**: insert the `pageLink` block synchronously with a placeholder,
  then create the child page asynchronously and update the block; remove it on failure.
  The synchronous insert must happen before any `await` or BlockNote loses the position.
- **Two-stage Cmd+A**: first press selects the current block's text, second selects all.
- **Notion-look CSS** (side-menu heights per block type, small grey drag handle, tighter
  heading sizes).
- The assistant bubble's `<think>` parsing (including unclosed tags mid-stream), the
  auto-growing textarea, and `streamPost` for SSE over POST.

Deliberately not carried over: page-tree drag-and-drop (moves go through the menu),
`prompt()`/`confirm()` dialogs for rename and delete, and a file-attach stub.

New in Graite: BlockNote `uploadFile` handler → `POST /media/upload?page=<path>` → returns
a `vault://` URL; a `pdf` block on `pdfjs-dist`; audio/video via BlockNote's built-in blocks.
