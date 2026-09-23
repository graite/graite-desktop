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
  TextInline,
} from "./types";

// ---------------------------------------------------------------------------------------
// markdown -> blocks
// ---------------------------------------------------------------------------------------

export function toBlocks(markdown: string): Block[] {
  return nodesToBlocks(parse(markdown).children);
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
      return [toggleBlock(node) ?? raw(node)];
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

/** `> [!toggle]- Title` + body ↔ toggleListItem. Every other callout type stays raw for now. */
function toggleBlock(node: Callout): Block | null {
  if (node.calloutType !== "toggle") return null;
  const content = toInline(titlePhrasing(node.title));
  if (!content) return null;
  return { type: "toggleListItem", props: {}, content, children: nodesToBlocks(node.children) };
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

function codeBlock(node: Code): Block | null {
  if (node.meta != null) return null;
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
      // `field` is the legacy name of `group`. `show` maps a view kind to the property names it
      // displays (kind absent = that view's default, [] = none); a bare list is the legacy form
      // for the fence's own view.
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
      if (
        Object.keys(p).some((k) => !keys.includes(k)) ||
        Object.values(p).some((v) => typeof v !== "string")
      )
        return null;
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
  if (node.align?.some((a) => a != null)) return null;
  const rows: { cells: InlineContent[][] }[] = [];
  for (const row of node.children) {
    const cells: InlineContent[][] = [];
    for (const cell of row.children) {
      const content = toInline(cell.children);
      if (!content) return null;
      cells.push(content);
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
          align: block.content.rows[0]?.cells.map(() => null) ?? [],
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
