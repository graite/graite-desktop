/**
 * The block and inline shapes @graite/md-convert produces and consumes.
 *
 * They mirror BlockNote 0.47's document JSON (`{ id?, type, props, content, children }`)
 * for the built-in blocks, plus Graite's custom blocks (`pageLink`, `rawMarkdown`) and the
 * custom `wikilink` inline content. The desktop schema (apps/desktop/src/editor/schema.ts)
 * must use the same type names and prop names.
 */
import type { BlockContent, Data, Literal, Parent } from "mdast";

// ---------------------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------------------

export interface Styles {
  bold?: true;
  italic?: true;
  strike?: true;
  code?: true;
}

export interface TextInline {
  type: "text";
  text: string;
  styles: Styles;
}

export interface LinkInline {
  type: "link";
  href: string;
  content: TextInline[];
}

export interface WikilinkInline {
  type: "wikilink";
  props: {
    /** Link target as written between the brackets (a page title). */
    target: string;
    /** Display alias (`[[target|alias]]`), empty when none was written. */
    alias: string;
  };
}

export type InlineContent = TextInline | LinkInline | WikilinkInline;

// ---------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------

interface BlockBase {
  id?: string;
  children: Block[];
}

export interface ParagraphBlock extends BlockBase {
  type: "paragraph";
  props: Record<string, never>;
  content: InlineContent[];
}

export interface HeadingBlock extends BlockBase {
  type: "heading";
  props: { level: 1 | 2 | 3 | 4 | 5 | 6 };
  content: InlineContent[];
}

export interface BulletListItemBlock extends BlockBase {
  type: "bulletListItem";
  props: Record<string, never>;
  content: InlineContent[];
}

export interface NumberedListItemBlock extends BlockBase {
  type: "numberedListItem";
  /** `start` is only set on the first item of a list that does not start at 1. */
  props: { start?: number };
  content: InlineContent[];
}

export interface CheckListItemBlock extends BlockBase {
  type: "checkListItem";
  props: { checked: boolean };
  content: InlineContent[];
}

export interface QuoteBlock extends BlockBase {
  type: "quote";
  props: Record<string, never>;
  content: InlineContent[];
}

export interface CodeBlock extends BlockBase {
  type: "codeBlock";
  props: { language: string };
  content: TextInline[];
}

/** A table cell as BlockNote stores it; `textAlignment` carries a GFM column alignment. */
export interface TableCell {
  type: "tableCell";
  props?: { textAlignment?: "left" | "center" | "right" | "justify" };
  content: InlineContent[];
}

export interface TableBlock extends BlockBase {
  type: "table";
  props: Record<string, never>;
  /**
   * `headerRows` is always 1 on parse: a GFM table always has a header row. Cells are plain
   * inline arrays, or `tableCell`s when the column is centered or right-aligned.
   */
  content: {
    type: "tableContent";
    headerRows?: number;
    rows: { cells: (InlineContent[] | TableCell)[] }[];
  };
}

/**
 * A plain-text toggle: the inline content is the title, `children` is the body.
 * Markdown: an Obsidian foldable callout `> [!toggle]- Title` (docs/vault-format.md §5).
 */
export interface ToggleListItemBlock extends BlockBase {
  type: "toggleListItem";
  props: Record<string, never>;
  content: InlineContent[];
}

/**
 * An Obsidian callout, `> [!note] Title` + body: the inline content is the title and
 * `children` the body. `folded` is the marker after the type: "", "-" (folded) or "+".
 */
export interface CalloutBlock extends BlockBase {
  type: "callout";
  props: { kind: string; folded: "" | "-" | "+" };
  content: InlineContent[];
}

export interface ImageBlock extends BlockBase {
  type: "image";
  props: { url: string; caption: string };
}

export interface DividerBlock extends BlockBase {
  type: "divider";
  props: Record<string, never>;
}

/**
 * A page link block: `[[target]]` alone on a line. `target` is the exact wikilink text and is
 * what gets serialized (falling back to `title`, then `path`). On parse `target === title`
 * and `path` is empty; the editor resolves `path`/`title`/`icon` against the page tree.
 */
export interface PageLinkBlock extends BlockBase {
  type: "pageLink";
  props: {
    path: string;
    title: string;
    icon: string;
    /** "1" when the linked page has no body text (drives the blank page icon); never serialized. */
    empty?: string;
    target: string;
  };
}

/** Anything the converter cannot model, kept verbatim so nothing is lost. */
export interface RawMarkdownBlock extends BlockBase {
  type: "rawMarkdown";
  props: { source: string };
}

/** Page-relative immutable local files; represented by graite YAML fences. */
export interface MediaBlock extends BlockBase {
  type: "localMedia";
  props: { file: string; name: string; kind: string; job: string };
}

export interface DerivedTextBlock extends BlockBase {
  type: "derivedText";
  props: { file: string; name: string; source: string };
}

export interface ColumnLayoutBlock extends BlockBase {
  type: "columnLayout";
  props: { count: number };
}
export interface PageColumnBlock extends BlockBase {
  type: "pageColumn";
  props: Record<string, never>;
}
export interface PageViewBlock extends BlockBase {
  type: "pageView";
  props: { view: string; group: string; show: string; settings?: string };
}

/**
 * A view over a CSV table in a page's `_data/` (D68). Written as a ```` ```graite:table ````
 * YAML fence, or as an Obsidian embed `![[name.csv]]` while no view state is set (`embed`).
 * `sort` and `columns` hold the YAML value as written: `sort` is text or a JSON list, `columns`
 * is "" when absent or a JSON list. Empty strings and `height: 0` mean the key is absent.
 */
export interface TableViewBlock extends BlockBase {
  type: "tableView";
  props: {
    source: string;
    view: string;
    filter: string;
    sort: string;
    columns: string;
    height: number;
    embed: boolean;
    /** JSON of `{ [source]: { filter?, sort?, columns? } }`: the other tabs' views. */
    tabs: string;
  };
}

/**
 * A chart over a page's CSV tables (D72), written as a ```` ```graite:chart ```` YAML fence.
 * Text keys hold their value ("" = absent); `y` is text or a JSON list; `limit` and `height`
 * are 0 when absent; `stacked` is "" when absent, else "true" or "false".
 */
export interface ChartBlock extends BlockBase {
  type: "chart";
  props: {
    title: string;
    source: string;
    sql: string;
    type: string;
    x: string;
    y: string;
    series: string;
    filter: string;
    sort: string;
    limit: number;
    stacked: string;
    height: number;
    /** mono/grayscale (default when ""), vivid, ocean, sunset, forest or candy. */
    palette: string;
  };
}

/** An HTML dashboard from the page's `_dashboards/` (D72): a ```` ```graite:dashboard ```` fence. */
export interface DashboardBlock extends BlockBase {
  type: "dashboard";
  props: { src: string; height: number };
}

export type Block =
  | ColumnLayoutBlock
  | PageColumnBlock
  | PageViewBlock
  | ParagraphBlock
  | HeadingBlock
  | BulletListItemBlock
  | NumberedListItemBlock
  | CheckListItemBlock
  | QuoteBlock
  | CodeBlock
  | TableBlock
  | ToggleListItemBlock
  | CalloutBlock
  | ImageBlock
  | DividerBlock
  | PageLinkBlock
  | RawMarkdownBlock
  | MediaBlock
  | DerivedTextBlock
  | TableViewBlock
  | ChartBlock
  | DashboardBlock;

export type BlockType = Block["type"];

// ---------------------------------------------------------------------------------------
// mdast augmentation for the wikiLink node produced by remark-wiki-link
// ---------------------------------------------------------------------------------------

export interface WikiLinkData extends Data {
  /** Display text; remark-wiki-link sets it to the target when no alias was written. */
  alias?: string;
  permalink?: string;
  exists?: boolean;
}

export interface WikiLink extends Literal {
  type: "wikiLink";
  value: string;
  data?: WikiLinkData;
}

// ---------------------------------------------------------------------------------------
// mdast node for Obsidian callouts (`> [!type]- Title` + body), produced by our parse pass
// ---------------------------------------------------------------------------------------

export interface Callout extends Parent {
  type: "callout";
  /** The word between `[!` and `]`, e.g. `note`, `toggle`. */
  calloutType: string;
  /** `-` → true (collapsed), `+` → false (expanded), none → null. */
  folded: boolean | null;
  /** Title as markdown source (already escaped), single line, may be empty. */
  title: string;
  /**
   * Body. A leading paragraph is always written directly under the title line (no blank `>`
   * line), which is how Obsidian users write callouts; other leading blocks get a blank line.
   */
  children: BlockContent[];
}

/** An Obsidian embed, `![[target]]`, lifted out of text by our parse pass. */
export interface Embed extends Literal {
  type: "embed";
  /** Everything between `![[` and `]]`, alias included. */
  value: string;
}

declare module "mdast" {
  interface PhrasingContentMap {
    wikiLink: WikiLink;
    embed: Embed;
  }
  interface RootContentMap {
    wikiLink: WikiLink;
    embed: Embed;
    callout: Callout;
  }
  interface BlockContentMap {
    callout: Callout;
  }
}
