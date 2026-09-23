/**
 * @graite/md-convert — markdown <-> BlockNote, owned by Graite (docs/design/editor-roundtrip.md).
 *
 * - `parse` / `serialize` / `canonical`: the pinned unified pipeline.
 * - `toBlocks` / `fromBlocks`: the block mapping (headings, paragraphs, lists, quotes, code,
 *   tables, dividers, images, page links, wikilinks) with `rawMarkdown` as the lossless
 *   escape hatch for everything else.
 */
export {
  CALLOUT_RE,
  SERIALIZER_OPTIONS,
  WIKI_LINK_OPTIONS,
  canonical,
  parse,
  phrasingToText,
  serialize,
} from "./markdown";
export { fromBlocks, toBlocks, toBlocksWithSpans } from "./blocks";
export type { BlockSpan } from "./blocks";
export { fromInline, toInline } from "./inline";
export type * from "./types";
