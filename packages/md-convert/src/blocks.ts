/**
 * markdown <-> Graite blocks (docs/design/editor-roundtrip.md §3).
 *
 * `toBlocks(markdown)` parses with the pinned parser and maps mdast to blocks;
 * `fromBlocks(blocks)` rebuilds mdast and serializes with the pinned options, so
 * `fromBlocks(toBlocks(md)) === canonical(md)` for everything the mapping covers.
 * Anything not covered becomes a `rawMarkdown` block that is re-parsed on the way back,
 * which is what makes the round trip lossless.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  BlockContent,
  Blockquote,
  Code,
  PhrasingContent as MdPhrasing,
  Heading,
  Image,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from "mdast";
import { canonical, parse, phrasingToText, serialize } from "./markdown";
import { fromInline, toInline } from "./inline";
import type {
  Block,
  BulletListItemBlock,
  Callout,
  CheckListItemBlock,
  InlineContent,
  NumberedListItemBlock,
  TableCell,
  TextInline,
} from "./types";

// ---------------------------------------------------------------------------------------
// markdown -> blocks
// ---------------------------------------------------------------------------------------

export function toBlocks(markdown: string): Block[] {
  return nodesToBlocks(parse(markdown).children);
}

/**
 * `toBlocks` that never fails as a whole: if mapping the page throws, each top-level node is
 * mapped on its own and only the ones that fail become `rawMarkdown` blocks of their source.
 */
export function toBlocksSafe(markdown: string): Block[] {
  try {
    return toBlocks(markdown);
  } catch {
    const out: Block[] = [];
    for (const node of parse(markdown).children) {
      try {
        out.push(...nodeToBlocks(node));
      } catch {
        const { start, end } = spanOf(node);
        const source = start >= 0 ? markdown.slice(start, end) : serialize(rootOf([node]));
        out.push({ type: "rawMarkdown", props: { source }, children: [] });
      }
    }
    return out;
  }
}

/** True when any block (at any depth) is a `rawMarkdown` block. */
export function hasRawBlocks(blocks: Block[]): boolean {
  return blocks.some((b) => b.type === "rawMarkdown" || hasRawBlocks(b.children));
}

/** Character range `[start, end)` of a top-level block in the markdown it was parsed from. */
export interface BlockSpan {
  start: number;
  end: number;
}

const NO_SPAN: BlockSpan = { start: -1, end: -1 };

function spanOf(node: { position?: RootContent["position"] }): BlockSpan {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start == null || end == null ? NO_SPAN : { start, end };
}

/**
 * `toBlocks` plus where each top-level block came from, index-aligned with `blocks`. A list
 * item's span covers its nested items; a list kept as one raw block spans the whole list.
 * Lets the editor place a marker at a position in the source (review proposals).
 */
export function toBlocksWithSpans(markdown: string): { blocks: Block[]; spans: BlockSpan[] } {
  const blocks: Block[] = [];
  const spans: BlockSpan[] = [];
  for (const node of parse(markdown).children) {
    const mapped = nodeToBlocks(node);
    const perItem = node.type === "list" && mapped.length === node.children.length;
    mapped.forEach((block, index) => {
      blocks.push(block);
      spans.push(spanOf(perItem ? (node as List).children[index]! : node));
    });
  }
  return { blocks, spans };
}

function nodesToBlocks(nodes: RootContent[]): Block[] {
  const out: Block[] = [];
  for (const node of nodes) out.push(...nodeToBlocks(node));
  return out;
}

function nodeToBlocks(node: RootContent): Block[] {
  switch (node.type) {
    case "html":
      if (isEmptyMarker(node)) return [{ type: "paragraph", props: {}, content: [], children: [] }];
      return [raw(node)];
    case "heading":
      return [headingBlock(node) ?? raw(node)];
    case "paragraph":
      return [paragraphBlock(node) ?? raw(node)];
    case "blockquote":
      return [quoteBlock(node) ?? raw(node)];
    case "callout":
      return [toggleBlock(node) ?? calloutBlock(node) ?? raw(node)];
    case "code":
      return [codeBlock(node) ?? raw(node)];
    case "thematicBreak":
      return [{ type: "divider", props: {}, children: [] }];
    case "list":
      return listBlocks(node);
    case "table":
      return [tableBlock(node) ?? raw(node)];
    default:
      // html, definition, footnoteDefinition, yaml, math, ...
      return [raw(node)];
  }
}

/** The serializer's stand-in for an empty paragraph (see `fromBlocks`). */
function isEmptyMarker(node: RootContent): boolean {
  return node.type === "html" && node.value.trim() === "<!-- graite:empty -->";
}

function raw(node: RootContent): Block {
  return { type: "rawMarkdown", props: { source: serialize(rootOf([node])) }, children: [] };
}

function rootOf(children: RootContent[]): Root {
  return { type: "root", children };
}

function headingBlock(node: Heading): Block | null {
  const content = toInline(node.children);
  if (!content) return null;
  return { type: "heading", props: { level: node.depth }, content, children: [] };
}

function paragraphBlock(node: Paragraph): Block | null {
  const only = node.children.length === 1 ? node.children[0] : undefined;
  if (only?.type === "wikiLink") {
    const target = only.value;
    return { type: "pageLink", props: { path: "", title: target, icon: "", target }, children: [] };
  }
  if (only?.type === "image") return imageBlock(only);
  if (only?.type === "embed" && /\.csv$/i.test(only.value.trim())) {
    // `![[name.csv]]` alone on its line shows the whole table; other embeds stay text.
    return {
      type: "tableView",
      props: { ...EMPTY_TABLE, source: only.value.trim(), embed: true },
      children: [],
    };
  }
  const content = toInline(node.children);
  if (!content) return null;
  return { type: "paragraph", props: {}, content, children: [] };
}

function imageBlock(node: Image): Block | null {
  if (node.title != null) return null;
  return { type: "image", props: { url: node.url, caption: node.alt ?? "" }, children: [] };
}

function quoteBlock(node: Blockquote): Block | null {
  const only = node.children.length === 1 ? node.children[0] : undefined;
  if (only?.type !== "paragraph") return null;
  const content = toInline(only.children);
  if (!content) return null;
  return { type: "quote", props: {}, content, children: [] };
}

/** `> [!toggle]- Title` + body ↔ toggleListItem. */
function toggleBlock(node: Callout): Block | null {
  if (node.calloutType !== "toggle") return null;
  const content = toInline(titlePhrasing(node.title));
  if (!content) return null;
  return { type: "toggleListItem", props: {}, content, children: nodesToBlocks(node.children) };
}

/** Every other callout type (`[!note]`, `[!warning]`, …) ↔ callout. */
function calloutBlock(node: Callout): Block | null {
  const content = toInline(titlePhrasing(node.title));
  if (!content) return null;
  const folded = node.folded === true ? "-" : node.folded === false ? "+" : "";
  return {
    type: "callout",
    props: { kind: node.calloutType, folded },
    content,
    children: nodesToBlocks(node.children),
  };
}

function titlePhrasing(title: string): MdPhrasing[] {
  if (!title) return [];
  const first = parse(title).children[0];
  return first?.type === "paragraph" ? first.children : [{ type: "text", value: title }];
}

const VIEW_KINDS = ["table", "kanban", "list"];
const FIELD_KINDS = [
  "text",
  "number",
  "single_select",
  "multi_select",
  "date",
  "checkbox",
  "email",
  "url",
  "media",
  "status",
  "created",
  "updated",
];

function validFields(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return false;
      if (
        typeof field.name !== "string" ||
        !field.name.trim() ||
        field.name.trim().length > 100 ||
        !FIELD_KINDS.includes(field.type)
      )
        return false;
      return (
        field.options === undefined ||
        (Array.isArray(field.options) &&
          field.options.length <= 100 &&
          field.options.every(
            (o: unknown) => typeof o === "string" && !!o.trim() && o.length <= 100,
          ))
      );
    })
  );
}

const TABLE_KEYS = ["source", "view", "filter", "sort", "columns", "height", "tabs"];
const TAB_KEYS = ["filter", "sort", "columns"];
const TABLE_VIEWS = ["table"];
const EMPTY_TABLE = {
  source: "",
  view: "",
  filter: "",
  sort: "",
  columns: "",
  height: 0,
  embed: false,
  tabs: "",
};

/** A `graite:table` fence; the same rules as `_check_table` in apps/daemon/graite/vault/blocks.py. */
function tableViewBlock(node: Code): Block | null {
  try {
    const value: unknown = parseYaml(node.value, { maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const names = (x: unknown): x is string[] =>
      Array.isArray(x) && x.every((n) => typeof n === "string" && !!n.trim());
    // tabs: the view each other table of the block keeps, keyed like `source` (D71).
    const tab = (x: unknown): boolean => {
      if (!x || typeof x !== "object" || Array.isArray(x)) return false;
      const t = x as Record<string, unknown>;
      return (
        Object.keys(t).every((k) => TAB_KEYS.includes(k)) &&
        (t.filter === undefined || typeof t.filter === "string") &&
        (t.sort === undefined || typeof t.sort === "string" || names(t.sort)) &&
        (t.columns === undefined ||
          names(t.columns) ||
          (Array.isArray(t.columns) && !t.columns.length))
      );
    };
    if (
      Object.keys(v).some((k) => !TABLE_KEYS.includes(k)) ||
      (v.tabs !== undefined &&
        (!v.tabs ||
          typeof v.tabs !== "object" ||
          Array.isArray(v.tabs) ||
          !Object.values(v.tabs).every(tab))) ||
      typeof v.source !== "string" ||
      !v.source.trim() ||
      (v.view !== undefined && !TABLE_VIEWS.includes(v.view as string)) ||
      (v.filter !== undefined && typeof v.filter !== "string") ||
      (v.sort !== undefined && typeof v.sort !== "string" && !names(v.sort)) ||
      (v.columns !== undefined && !names(v.columns)) ||
      (v.height !== undefined &&
        (typeof v.height !== "number" ||
          !Number.isInteger(v.height) ||
          v.height < 120 ||
          v.height > 2000))
    )
      return null;
    return {
      type: "tableView",
      props: {
        source: v.source,
        view: (v.view as string | undefined) ?? "",
        filter: (v.filter as string | undefined) ?? "",
        sort: Array.isArray(v.sort) ? JSON.stringify(v.sort) : ((v.sort as string) ?? ""),
        columns: v.columns === undefined ? "" : JSON.stringify(v.columns),
        height: (v.height as number | undefined) ?? 0,
        embed: false,
        tabs: v.tabs === undefined ? "" : JSON.stringify(v.tabs),
      },
      children: [],
    };
  } catch {
    return null;
  }
}

const CHART_KEYS = [
  "title",
  "source",
  "sql",
  "type",
  "x",
  "y",
  "series",
  "filter",
  "sort",
  "limit",
  "stacked",
  "height",
  "palette",
];
const CHART_PALETTES = ["vivid", "ocean", "sunset", "forest", "candy", "mono"];
const CHART_TYPES = ["bar", "line", "area", "pie", "donut", "scatter", "number"];
const CHART_AGG = /^\s*(count|sum|avg|min|max)\s*\(\s*(.+?)\s*\)\s*$/i;
const CHART_COUNT = /^\s*count\s*(?:\(\s*\))?\s*$/i;
// An aggregate the builder once saved without its field (`sum()`): kept as a chart, which
// asks for a number field, though the daemon refuses it from a model (chart-cases.json).
const CHART_AGG_EMPTY = /^\s*(sum|avg|min|max)\s*\(\s*\)\s*$/i;
/** count, agg(column), or a plain number column; the same rule as `y_problem` in charts.py. */
const chartY = (y: string) =>
  CHART_COUNT.test(y) ||
  CHART_AGG.test(y) ||
  CHART_AGG_EMPTY.test(y) ||
  (!!y.trim() && !/[()]/.test(y));
const CHART_SORT = /^\s*(x|y)\s+(asc|desc)\s*$/i;
export const EMPTY_CHART = {
  title: "",
  source: "",
  sql: "",
  type: "",
  x: "",
  y: "",
  series: "",
  filter: "",
  sort: "",
  limit: 0,
  stacked: "",
  height: 0,
  palette: "",
};

/** A `graite:chart` fence; the same rules as `check_chart` in apps/daemon/graite/tables/charts.py. */
function chartBlock(node: Code): Block | null {
  try {
    const value: unknown = parseYaml(node.value, { maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const text = (x: unknown) => typeof x === "string" && !!x.trim();
    const int = (x: unknown, lo: number, hi: number) =>
      typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
    const kind = v.type ?? "bar";
    const ys =
      v.y === undefined
        ? ["count"]
        : typeof v.y === "string"
          ? [v.y]
          : Array.isArray(v.y) && v.y.length && v.y.every(text)
            ? (v.y as string[])
            : null;
    if (
      Object.keys(v).some((k) => !CHART_KEYS.includes(k)) ||
      !CHART_TYPES.includes(kind as string) ||
      (v.source !== undefined && v.sql !== undefined) ||
      // A chart still being set up: only its look may be set yet.
      (v.source === undefined &&
        v.sql === undefined &&
        Object.keys(v).some((k) => !["title", "type", "height", "palette"].includes(k))) ||
      (v.source !== undefined && !text(v.source)) ||
      (v.sql !== undefined &&
        (!text(v.sql) || ["x", "y", "series", "filter"].some((k) => k in v))) ||
      (v.source !== undefined &&
        ((kind !== "number" && !text(v.x)) ||
          !ys ||
          (kind !== "scatter" && ys.some((y) => !chartY(y))) ||
          (v.series !== undefined && !text(v.series)) ||
          (v.series !== undefined && ys.length > 1) ||
          (v.filter !== undefined && typeof v.filter !== "string"))) ||
      (v.sort !== undefined && !(typeof v.sort === "string" && CHART_SORT.test(v.sort))) ||
      (v.limit !== undefined && !int(v.limit, 1, 500)) ||
      (v.stacked !== undefined && typeof v.stacked !== "boolean") ||
      (v.height !== undefined && !int(v.height, 120, 2000)) ||
      (v.title !== undefined && typeof v.title !== "string") ||
      (v.palette !== undefined && !CHART_PALETTES.includes(v.palette as string))
    )
      return null;
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    return {
      type: "chart",
      props: {
        title: str(v.title),
        source: str(v.source),
        sql: str(v.sql),
        type: str(v.type),
        x: str(v.x),
        y: Array.isArray(v.y) ? JSON.stringify(v.y) : str(v.y),
        series: str(v.series),
        filter: str(v.filter),
        sort: str(v.sort),
        limit: (v.limit as number | undefined) ?? 0,
        stacked: v.stacked === undefined ? "" : String(v.stacked),
        height: (v.height as number | undefined) ?? 0,
        palette: str(v.palette),
      },
      children: [],
    };
  } catch {
    return null;
  }
}

const DASHBOARD_SRC = /^_dashboards\/[^/\\:*?"<>|]{1,120}\.html$/i;

/** A `graite:dashboard` fence; the same rules as `_check_dashboard` in vault/blocks.py. */
function dashboardBlock(node: Code): Block | null {
  try {
    const value: unknown = parseYaml(node.value, { maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).some((k) => k !== "src" && k !== "height") ||
      typeof v.src !== "string" ||
      !DASHBOARD_SRC.test(v.src.trim()) ||
      (v.height !== undefined &&
        (typeof v.height !== "number" ||
          !Number.isInteger(v.height) ||
          v.height < 120 ||
          v.height > 4000))
    )
      return null;
    return {
      type: "dashboard",
      props: { src: v.src.trim(), height: (v.height as number | undefined) ?? 0 },
      children: [],
    };
  } catch {
    return null;
  }
}

function codeBlock(node: Code): Block | null {
  if (node.meta != null) return null;
  if (node.lang === "graite:table") return tableViewBlock(node);
  if (node.lang === "graite:chart") return chartBlock(node);
  if (node.lang === "graite:dashboard") return dashboardBlock(node);
  if (node.lang === "graite:columns" || node.lang === "graite:view") {
    try {
      const value = parseYaml(node.value, { maxAliasCount: 0 });
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      if (node.lang === "graite:columns") {
        if (
          Object.keys(value).some((k) => k !== "columns") ||
          !Array.isArray(value.columns) ||
          value.columns.length < 2 ||
          value.columns.length > 4 ||
          value.columns.some((v: unknown) => typeof v !== "string")
        )
          return null;
        return {
          type: "columnLayout",
          props: { count: value.columns.length },
          children: value.columns.map((v: string) => ({
            type: "pageColumn",
            props: {},
            children: toBlocks(v).length
              ? toBlocks(v)
              : [{ type: "paragraph", props: {}, content: [], children: [] }],
          })),
        };
      }
      // `field` is the legacy name of `group`. `show` maps a view kind to the order of the
      // property names it displays (`settings.hide` lists the ones it leaves out); a bare list
      // is the legacy form for the fence's own view.
      const group = value.group ?? value.field;
      if (
        Object.keys(value).some(
          (k) => !["view", "group", "field", "show", "settings"].includes(k),
        ) ||
        !VIEW_KINDS.includes(value.view) ||
        (group !== undefined && typeof group !== "string")
      )
        return null;
      const names = (v: unknown): v is string[] =>
        Array.isArray(v) && v.every((x) => typeof x === "string" && !!x.trim());
      let show: Record<string, string[]> = {};
      if (names(value.show)) show = { [value.view]: value.show };
      else if (
        value.show &&
        typeof value.show === "object" &&
        Object.entries(value.show).every(([k, v]) => VIEW_KINDS.includes(k) && names(v))
      )
        show = value.show;
      else if (value.show !== undefined) return null;
      if (
        value.settings !== undefined &&
        (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings))
      )
        return null;
      if (value.settings?.fields !== undefined && !validFields(value.settings.fields)) return null;
      return {
        type: "pageView",
        props: {
          view: value.view,
          group: group ?? "",
          show: Object.keys(show).length ? JSON.stringify(show) : "",
          ...(value.settings ? { settings: JSON.stringify(value.settings) } : {}),
        },
        children: [],
      };
    } catch {
      return null;
    }
  }
  if (node.lang === "graite:media" || node.lang === "graite:text") {
    try {
      const value: unknown = parseYaml(node.value, { maxAliasCount: 0 });
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const p = value as Record<string, unknown>;
      const keys =
        node.lang === "graite:media" ? ["file", "name", "kind", "job"] : ["file", "name", "source"];
      // A value YAML reads as a number or date (`name: 2024`) or leaves empty (`job:`) is
      // still that text; only nested values make the fence unusable.
      if (
        Object.keys(p).some((k) => !keys.includes(k)) ||
        Object.values(p).some((v) => v !== null && typeof v === "object" && !(v instanceof Date))
      )
        return null;
      for (const key of Object.keys(p))
        p[key] =
          p[key] == null
            ? ""
            : p[key] instanceof Date
              ? (p[key] as Date).toISOString().slice(0, 10)
              : String(p[key]);
      if (node.lang === "graite:media")
        return [
          {
            type: "localMedia",
            props: {
              file: String(p.file ?? ""),
              name: String(p.name ?? ""),
              kind: String(p.kind ?? "audio"),
              job: String(p.job ?? ""),
            },
            children: [],
          },
        ][0] as Block;
      return {
        type: "derivedText",
        props: {
          file: String(p.file ?? ""),
          name: String(p.name ?? ""),
          source: String(p.source ?? ""),
        },
        children: [],
      };
    } catch {
      return null;
    }
  }
  const content: TextInline[] = [{ type: "text", text: node.value, styles: {} }];
  return { type: "codeBlock", props: { language: node.lang ?? "" }, content, children: [] };
}

function tableBlock(node: Table): Block | null {
  // BlockNote's default cell alignment is "left", so an explicit `:---` cannot be told apart
  // from no alignment on the way back; such tables stay raw. Centered and right work.
  if (node.align?.some((a) => a === "left")) return null;
  const aligned = node.align?.some((a) => a != null) ?? false;
  const rows: { cells: (InlineContent[] | TableCell)[] }[] = [];
  for (const row of node.children) {
    const cells: (InlineContent[] | TableCell)[] = [];
    for (const [index, cell] of row.children.entries()) {
      const content = toInline(cell.children);
      if (!content) return null;
      const align = node.align?.[index];
      cells.push(
        aligned
          ? {
              type: "tableCell",
              props: { textAlignment: align === "center" || align === "right" ? align : "left" },
              content,
            }
          : content,
      );
    }
    rows.push({ cells });
  }
  return {
    type: "table",
    props: {},
    content: { type: "tableContent", headerRows: 1, rows },
    children: [],
  };
}

function listBlocks(list: List): Block[] {
  // Loose lists (blank lines between items) have no BlockNote equivalent; keeping the whole
  // list verbatim is the only way to preserve them.
  if (list.spread || list.children.some((item) => item.spread)) return [raw(list)];
  const out: Block[] = [];
  list.children.forEach((item, index) => {
    const block = listItemBlock(list, item);
    if (block) {
      if (
        block.type === "numberedListItem" &&
        index === 0 &&
        list.start != null &&
        list.start !== 1
      ) {
        block.props.start = list.start;
      }
      out.push(block);
    } else {
      out.push(rawListItem(list, item));
    }
  });
  return out;
}

function listItemBlock(
  list: List,
  item: ListItem,
): BulletListItemBlock | NumberedListItemBlock | CheckListItemBlock | null {
  const [first, ...rest] = item.children;
  let content: InlineContent[] = [];
  if (first) {
    if (first.type !== "paragraph") return null;
    const inline = toInline(first.children);
    if (!inline) return null;
    content = inline;
  }
  const children: Block[] = [];
  for (const child of rest) {
    // An empty paragraph nested under an item is written as an indented marker; without
    // this the whole item came back as a read-only raw block.
    if (isEmptyMarker(child)) {
      children.push({ type: "paragraph", props: {}, content: [], children: [] });
      continue;
    }
    if (child.type !== "list") return null;
    children.push(...listBlocks(child));
  }
  if (item.checked != null) {
    return { type: "checkListItem", props: { checked: item.checked }, content, children };
  }
  if (list.ordered) return { type: "numberedListItem", props: {}, content, children };
  return { type: "bulletListItem", props: {}, content, children };
}

function rawListItem(list: List, item: ListItem): Block {
  const single: List = { ...list, children: [item] };
  return { type: "rawMarkdown", props: { source: serialize(rootOf([single])) }, children: [] };
}

// ---------------------------------------------------------------------------------------
// blocks -> markdown
// ---------------------------------------------------------------------------------------

export function fromBlocks(blocks: Block[]): string {
  // rawMarkdown sources are spliced in verbatim (as `html` nodes, which serialize as-is) and
  // the whole document is canonicalized once, so constructs that need document context
  // (footnote references, link reference definitions) resolve against the full text.
  return canonical(serialize(rootOf(mergeLists(blocksToNodes(blocks)))));
}

function blocksToNodes(blocks: Block[]): RootContent[] {
  const out: RootContent[] = [];
  for (const block of blocks) out.push(...blockToNodes(block));
  return out;
}

/** A column's GFM alignment from its header cell; BlockNote's default "left" means none. */
function cellAlign(cell: unknown): "center" | "right" | null {
  const align =
    cell && typeof cell === "object" && !Array.isArray(cell)
      ? (cell as TableCell).props?.textAlignment
      : undefined;
  return align === "center" || align === "right" ? align : null;
}

/** BlockNote accepts plain inline arrays as cells but stores `{ type: "tableCell", content }`. */
function cellContent(cell: unknown): InlineContent[] {
  if (Array.isArray(cell)) return cell as InlineContent[];
  if (cell && typeof cell === "object" && Array.isArray((cell as { content?: unknown }).content)) {
    return (cell as { content: InlineContent[] }).content;
  }
  return [];
}

function blockToNodes(block: Block): RootContent[] {
  const trailing = (): RootContent[] =>
    block.children.length ? blocksToNodes(block.children) : [];
  switch (block.type) {
    case "paragraph": {
      const children = fromInline(block.content);
      if (children.length === 0)
        return [{ type: "html", value: "<!-- graite:empty -->" }, ...trailing()];
      return [{ type: "paragraph", children }, ...trailing()];
    }
    case "heading":
      return [
        { type: "heading", depth: block.props.level, children: fromInline(block.content) },
        ...trailing(),
      ];
    case "quote":
      return [
        {
          type: "blockquote",
          children: [{ type: "paragraph", children: fromInline(block.content) }],
        },
        ...trailing(),
      ];
    case "codeBlock":
      return [
        {
          type: "code",
          lang: block.props.language || null,
          meta: null,
          value: block.content.map((c) => c.text).join(""),
        },
        ...trailing(),
      ];
    case "divider":
      return [{ type: "thematicBreak" }, ...trailing()];
    case "image":
      return [
        {
          type: "paragraph",
          children: [
            { type: "image", url: block.props.url, alt: block.props.caption, title: null },
          ],
        },
        ...trailing(),
      ];
    case "pageLink": {
      const target = block.props.target || block.props.title || block.props.path;
      const link: PhrasingContent = {
        type: "wikiLink",
        value: target,
        data: { alias: target, permalink: target, exists: true },
      };
      return [{ type: "paragraph", children: [link] }, ...trailing()];
    }
    case "table":
      return [
        {
          type: "table",
          align: block.content.rows[0]?.cells.map(cellAlign) ?? [],
          children: block.content.rows.map((row) => ({
            type: "tableRow",
            children: row.cells.map((cell) => ({
              type: "tableCell",
              children: fromInline(cellContent(cell)),
            })),
          })),
        },
        ...trailing(),
      ];
    case "toggleListItem": {
      const body = mergeLists(blocksToNodes(block.children)) as BlockContent[];
      const callout: Callout = {
        type: "callout",
        calloutType: "toggle",
        folded: true,
        title: phrasingToText(fromInline(block.content)),
        children: body,
      };
      return [callout];
    }
    case "callout": {
      const body = mergeLists(blocksToNodes(block.children)) as BlockContent[];
      const callout: Callout = {
        type: "callout",
        calloutType: block.props.kind || "note",
        folded: block.props.folded === "-" ? true : block.props.folded === "+" ? false : null,
        title: phrasingToText(fromInline(block.content)),
        children: body,
      };
      return [callout];
    }
    case "bulletListItem":
    case "checkListItem":
      return [
        { type: "list", ordered: false, start: null, spread: false, children: [listItem(block)] },
      ];
    case "numberedListItem":
      return [
        {
          type: "list",
          ordered: true,
          start: block.props.start ?? 1,
          spread: false,
          children: [listItem(block)],
        },
      ];
    case "columnLayout": {
      const count = Math.max(2, Math.min(4, block.props.count));
      const columns = Array.from({ length: count }, () => "");
      block.children.forEach((column, index) => {
        const markdown = fromBlocks(column.type === "pageColumn" ? column.children : [column]);
        const slot = Math.min(index, count - 1);
        columns[slot] += (columns[slot] && markdown ? "\n" : "") + markdown;
      });
      return [
        {
          type: "code",
          lang: "graite:columns",
          meta: null,
          value: stringifyYaml({ columns }, { lineWidth: 0 }).trimEnd(),
        },
      ];
    }
    case "pageColumn":
      return blocksToNodes(block.children);
    case "pageView": {
      let stored: Record<string, unknown> = {};
      try {
        const parsed: unknown = block.props.show ? JSON.parse(block.props.show) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          stored = parsed as Record<string, unknown>;
      } catch {
        stored = {};
      }
      const show: Record<string, string[]> = {};
      for (const kind of VIEW_KINDS)
        if (Array.isArray(stored[kind])) show[kind] = (stored[kind] as unknown[]).map(String);
      let settings: Record<string, unknown> = {};
      try {
        const value = JSON.parse(block.props.settings || "{}");
        if (value && typeof value === "object" && !Array.isArray(value)) settings = value;
      } catch {
        /* Empty settings. */
      }
      const props = {
        ...(Object.keys(settings).length ? { settings } : {}),
        view: block.props.view,
        ...(block.props.group ? { group: block.props.group } : {}),
        ...(Object.keys(show).length ? { show } : {}),
      };
      return [
        {
          type: "code",
          lang: "graite:view",
          meta: null,
          value: stringifyYaml(props, { lineWidth: 0 }).trimEnd(),
        },
        ...trailing(),
      ];
    }
    case "chart": {
      const p = block.props;
      let y: string | string[] = p.y;
      try {
        if (p.y.startsWith("[")) y = (JSON.parse(p.y) as unknown[]).map(String);
      } catch {
        /* Keep it as text. */
      }
      const props = {
        ...(p.title ? { title: p.title } : {}),
        ...(p.source ? { source: p.source } : {}),
        ...(p.sql ? { sql: p.sql } : {}),
        ...(p.type ? { type: p.type } : {}),
        ...(p.x ? { x: p.x } : {}),
        ...(y.length ? { y } : {}),
        ...(p.series ? { series: p.series } : {}),
        ...(p.filter ? { filter: p.filter } : {}),
        ...(p.sort ? { sort: p.sort } : {}),
        ...(p.limit ? { limit: p.limit } : {}),
        ...(p.stacked ? { stacked: p.stacked === "true" } : {}),
        ...(p.height ? { height: p.height } : {}),
        ...(p.palette ? { palette: p.palette } : {}),
      };
      return [
        {
          type: "code",
          lang: "graite:chart",
          meta: null,
          value: stringifyYaml(props, { lineWidth: 0 }).trimEnd(),
        },
        ...trailing(),
      ];
    }
    case "dashboard": {
      const p = block.props;
      const props = { src: p.src, ...(p.height ? { height: p.height } : {}) };
      return [
        {
          type: "code",
          lang: "graite:dashboard",
          meta: null,
          value: stringifyYaml(props, { lineWidth: 0 }).trimEnd(),
        },
        ...trailing(),
      ];
    }
    case "tableView": {
      const p = block.props;
      let sort: string | string[] = p.sort;
      let columns: string[] | undefined;
      try {
        if (p.sort.startsWith("[")) sort = (JSON.parse(p.sort) as unknown[]).map(String);
        if (p.columns) columns = (JSON.parse(p.columns) as unknown[]).map(String);
      } catch {
        /* Keep what parses. */
      }
      let tabs: Record<string, unknown> | undefined;
      try {
        if (p.tabs) tabs = JSON.parse(p.tabs) as Record<string, unknown>;
      } catch {
        /* Keep what parses. */
      }
      if (tabs && !Object.keys(tabs).length) tabs = undefined;
      const plain = !p.view && !p.filter && !p.sort && !p.columns && !p.height && !tabs;
      if (p.embed && plain && /\.csv$/i.test(p.source) && !/[[\]\n]/.test(p.source))
        return [
          { type: "paragraph", children: [{ type: "embed", value: p.source }] },
          ...trailing(),
        ];
      const props = {
        source: p.source,
        ...(p.view ? { view: p.view } : {}),
        ...(p.filter ? { filter: p.filter } : {}),
        ...(sort.length ? { sort } : {}),
        ...(columns ? { columns } : {}),
        ...(p.height ? { height: p.height } : {}),
        ...(tabs ? { tabs } : {}),
      };
      return [
        {
          type: "code",
          lang: "graite:table",
          meta: null,
          value: stringifyYaml(props, { lineWidth: 0 }).trimEnd(),
        },
        ...trailing(),
      ];
    }
    case "localMedia":
    case "derivedText": {
      const props =
        block.type === "localMedia"
          ? {
              file: block.props.file,
              name: block.props.name,
              kind: block.props.kind,
              ...(block.props.job ? { job: block.props.job } : {}),
            }
          : { file: block.props.file, name: block.props.name, source: block.props.source };
      return [
        {
          type: "code",
          lang: block.type === "localMedia" ? "graite:media" : "graite:text",
          meta: null,
          value: stringifyYaml(props, { lineWidth: 0 }).trimEnd(),
        },
        ...trailing(),
      ];
    }
    case "rawMarkdown":
      return [{ type: "html", value: block.props.source.replace(/\n+$/, "") }, ...trailing()];
  }
}

function listItem(
  block: BulletListItemBlock | NumberedListItemBlock | CheckListItemBlock,
): ListItem {
  const children: BlockContent[] = [];
  const inline = fromInline(block.content);
  if (inline.length) children.push({ type: "paragraph", children: inline });
  const nested = mergeLists(blocksToNodes(block.children));
  for (const node of nested) children.push(node as BlockContent);
  return {
    type: "listItem",
    spread: false,
    checked: block.type === "checkListItem" ? block.props.checked : null,
    children,
  };
}

/** Consecutive list items become one list, as the parser would have produced. */
function mergeLists(nodes: RootContent[]): RootContent[] {
  const out: RootContent[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (
      node.type === "list" &&
      prev?.type === "list" &&
      prev.ordered === node.ordered &&
      !prev.spread &&
      !node.spread
    ) {
      prev.children.push(...node.children);
    } else {
      out.push(node);
    }
  }
  return out;
}
