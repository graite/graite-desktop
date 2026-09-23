/**
 * The pinned parser and serializer. Everything in this package goes through these two
 * functions so that `canonical(canonical(md)) === canonical(md)` and the block converter
 * agrees byte-for-byte with `canonical`.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkWikiLink from "remark-wiki-link";
import { toMarkdown, type Options as ToMarkdownOptions } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import { frontmatterToMarkdown } from "mdast-util-frontmatter";
import type {
  BlockContent,
  Blockquote,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Text,
} from "mdast";
import type { Callout, WikiLink } from "./types";

export const WIKI_LINK_OPTIONS = {
  aliasDivider: "|",
  pageResolver: (name: string) => [name],
  hrefTemplate: (permalink: string) => permalink,
};

/**
 * Serializer for the `wikiLink` node that remark-wiki-link parses. Written here rather than
 * taken from mdast-util-wiki-link because that one escapes every `[` in prose, which would
 * rewrite Obsidian callouts (`[!note]`) and plain `[x]` text. Only a literal `[[` needs
 * escaping to stay out of the wikilink syntax.
 */
const wikiLinkToMarkdown = (aliasDivider: string): ToMarkdownOptions => ({
  unsafe: [{ character: "[", after: "\\[", inConstruct: "phrasing" }],
  handlers: {
    wikiLink(node: WikiLink) {
      const alias = node.data?.alias;
      return alias && alias !== node.value
        ? `[[${node.value}${aliasDivider}${alias}]]`
        : `[[${node.value}]]`;
    },
  },
});

/** `[!type]`, optional fold marker, optional title on the same line. */
export const CALLOUT_RE = /^\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+|(?=\n|$))/;

/**
 * Serializer for the `callout` node (see `parse`). Writes the marker line verbatim so the
 * stock `[` escaping never touches it, then the body as blockquote lines.
 */
const calloutToMarkdown: ToMarkdownOptions = {
  handlers: {
    callout(node: Callout, _parent, state, info) {
      const exit = state.enter("blockquote");
      const marker = `[!${node.calloutType}]${node.folded === true ? "-" : node.folded === false ? "+" : ""}`;
      let value = "> " + (node.title ? `${marker} ${node.title}` : marker);
      if (node.children.length > 0) {
        const tracker = state.createTracker(info);
        tracker.move(value + "\n");
        const body = state.containerFlow(node, tracker.current());
        const lines = state.indentLines(
          body,
          (line, _index, blank) => ">" + (blank ? "" : " ") + line,
        );
        value += (node.children[0]?.type === "paragraph" ? "\n" : "\n>\n") + lines;
      }
      exit();
      return value;
    },
  },
};

/** Pinned serializer options. Changing these is a migration (see docs/design/editor-roundtrip.md §2). */
export const SERIALIZER_OPTIONS: ToMarkdownOptions = {
  bullet: "-",
  emphasis: "_",
  strong: "*",
  fences: true,
  listItemIndent: "one",
  rule: "-",
  incrementListMarker: true,
  extensions: [
    gfmToMarkdown(),
    frontmatterToMarkdown(["yaml"]),
    wikiLinkToMarkdown(WIKI_LINK_OPTIONS.aliasDivider),
    calloutToMarkdown,
  ],
};

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkWikiLink, WIKI_LINK_OPTIONS);

export function parse(markdown: string): Root {
  const tree = parser.parse(markdown) as Root;
  liftCallouts(tree);
  return tree;
}

/** Recursively replace blockquotes that start with `[!type]` by `callout` nodes. */
function liftCallouts(node: { children?: RootContent[] }): void {
  if (!node.children) return;
  node.children.forEach((child, index) => {
    liftCallouts(child as { children?: RootContent[] });
    if (child.type === "blockquote") {
      const callout = calloutFromBlockquote(child);
      if (callout) node.children![index] = callout;
    }
  });
}

function calloutFromBlockquote(quote: Blockquote): Callout | null {
  const first = quote.children[0];
  if (first?.type !== "paragraph") return null;
  const lead = first.children[0];
  if (lead?.type !== "text") return null;
  const match = CALLOUT_RE.exec(lead.value);
  if (!match) return null;

  // Split the first paragraph into the title line and whatever follows the first newline.
  const afterMarker = lead.value.slice(match[0].length);
  const titleNodes: PhrasingContent[] = [];
  const restNodes: PhrasingContent[] = [];
  const nl = afterMarker.indexOf("\n");
  if (nl === -1) {
    if (afterMarker) titleNodes.push({ type: "text", value: afterMarker });
    let splitAt = -1;
    for (let i = 1; i < first.children.length; i++) {
      const c = first.children[i]!;
      if (c.type === "text" && c.value.includes("\n")) {
        const at = c.value.indexOf("\n");
        if (at > 0) titleNodes.push({ type: "text", value: c.value.slice(0, at) });
        const tail = c.value.slice(at + 1);
        if (tail) restNodes.push({ type: "text", value: tail });
        splitAt = i;
        break;
      }
      titleNodes.push(c);
    }
    if (splitAt !== -1) restNodes.push(...first.children.slice(splitAt + 1));
  } else {
    const head = afterMarker.slice(0, nl);
    if (head) titleNodes.push({ type: "text", value: head });
    const tail = afterMarker.slice(nl + 1);
    if (tail) restNodes.push({ type: "text", value: tail } as Text);
    restNodes.push(...first.children.slice(1));
  }

  // Definitions inside a callout are not block content; keep the quote raw in that case.
  const rest = quote.children.slice(1);
  if (rest.some((c) => c.type === "definition" || c.type === "footnoteDefinition")) return null;
  const children = rest as BlockContent[];
  if (restNodes.length > 0)
    children.unshift({ type: "paragraph", children: restNodes } as Paragraph);

  return {
    type: "callout",
    calloutType: match[1]!,
    folded: match[2] === "-" ? true : match[2] === "+" ? false : null,
    title: phrasingToText(titleNodes),
    children,
    // Keep the quote's source range: `toBlocksWithSpans` needs it, serializing ignores it.
    position: quote.position,
  };
}

/** Serialize phrasing content to a single line of (escaped) markdown source. */
export function phrasingToText(children: PhrasingContent[]): string {
  if (children.length === 0) return "";
  const out = toMarkdown(
    { type: "root", children: [{ type: "paragraph", children }] },
    SERIALIZER_OPTIONS,
  );
  return out.replace(/\n+$/, "").trim();
}

export function serialize(tree: Root): string {
  return toMarkdown(tree, SERIALIZER_OPTIONS);
}

/** Canonical form of a markdown document under Graite's pinned serializer. */
export function canonical(markdown: string): string {
  return serialize(parse(markdown));
}
