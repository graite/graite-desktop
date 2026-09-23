/**
 * mdast phrasing content <-> BlockNote inline content.
 *
 * `toInline` returns null when it meets phrasing it cannot represent (inline html,
 * footnote references, inline images, ...). Callers then keep the whole block as
 * `rawMarkdown`.
 *
 * Style nesting is a set in BlockNote and a tree in markdown, so `fromInline` rebuilds the
 * tree in a fixed order: strike > italic > bold > code (matching how CommonMark parses
 * `***x***` as emphasis(strong)). Other nestings normalize to that order.
 */
import type { PhrasingContent } from "mdast";
import type { InlineContent, LinkInline, Styles, TextInline, WikiLinkData } from "./types";

type StyleName = keyof Styles;
const STYLE_ORDER: StyleName[] = ["strike", "italic", "bold", "code"];

// ---------------------------------------------------------------------------------------
// mdast -> inline
// ---------------------------------------------------------------------------------------

export function toInline(nodes: PhrasingContent[]): InlineContent[] | null {
  const out: InlineContent[] = [];
  if (!walk(nodes, {}, out)) return null;
  return mergeText(out);
}

function walk(nodes: PhrasingContent[], styles: Styles, out: InlineContent[]): boolean {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push(text(node.value, styles));
        break;
      case "break":
        out.push(text("\n", {}));
        break;
      case "inlineCode":
        out.push(text(node.value, { ...styles, code: true }));
        break;
      case "strong":
        if (!walk(node.children, { ...styles, bold: true }, out)) return false;
        break;
      case "emphasis":
        if (!walk(node.children, { ...styles, italic: true }, out)) return false;
        break;
      case "delete":
        if (!walk(node.children, { ...styles, strike: true }, out)) return false;
        break;
      case "link": {
        if (node.title != null) return false;
        const inner: InlineContent[] = [];
        if (!walk(node.children, styles, inner)) return false;
        if (inner.some((c) => c.type !== "text")) return false;
        out.push({ type: "link", href: node.url, content: mergeText(inner) as TextInline[] });
        break;
      }
      case "wikiLink": {
        const data = node.data as WikiLinkData | undefined;
        const alias = data?.alias && data.alias !== node.value ? data.alias : "";
        out.push({ type: "wikilink", props: { target: node.value, alias } });
        break;
      }
      default:
        return false; // html, image, footnoteReference, linkReference, ...
    }
  }
  return true;
}

function text(value: string, styles: Styles): TextInline {
  return { type: "text", text: value, styles: { ...styles } };
}

function sameStyles(a: Styles, b: Styles): boolean {
  return STYLE_ORDER.every((s) => Boolean(a[s]) === Boolean(b[s]));
}

/** Merge adjacent text runs with identical styles (BlockNote does the same). */
function mergeText(items: InlineContent[]): InlineContent[] {
  const out: InlineContent[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (item.type === "text" && prev?.type === "text" && sameStyles(prev.styles, item.styles)) {
      prev.text += item.text;
    } else {
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// inline -> mdast
// ---------------------------------------------------------------------------------------

export function fromInline(items: InlineContent[]): PhrasingContent[] {
  return build(splitBreaks(items));
}

/** Hard breaks travel as "\n" inside text items; turn them back into explicit atoms. */
type Atom = InlineContent | { type: "break" };

function splitBreaks(items: InlineContent[]): Atom[] {
  const atoms: Atom[] = [];
  for (const item of items) {
    if (item.type !== "text" || !item.text.includes("\n")) {
      atoms.push(item);
      continue;
    }
    const parts = item.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) atoms.push({ type: "break" });
      if (part) atoms.push({ type: "text", text: part, styles: item.styles });
    });
  }
  return atoms;
}

function activeStyles(item: Atom): StyleName[] {
  if (item.type !== "text") return [];
  return STYLE_ORDER.filter((s) => item.styles[s]);
}

function build(atoms: Atom[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < atoms.length) {
    const atom = atoms[i]!;
    if (atom.type === "break") {
      out.push({ type: "break" });
      i++;
      continue;
    }
    if (atom.type === "link") {
      out.push(linkNode(atom));
      i++;
      continue;
    }
    if (atom.type === "wikilink") {
      const { target, alias } = atom.props;
      out.push({
        type: "wikiLink",
        value: target,
        data: { alias: alias || target, permalink: target, exists: true },
      });
      i++;
      continue;
    }
    const styles = activeStyles(atom);
    if (styles.length === 0) {
      out.push({ type: "text", value: atom.text });
      i++;
      continue;
    }
    const outer = styles[0]!;
    if (outer === "code") {
      out.push({ type: "inlineCode", value: atom.text });
      i++;
      continue;
    }
    // Extend the run while following text atoms carry the same outer style.
    let j = i;
    while (j < atoms.length) {
      const next = atoms[j]!;
      if (next.type !== "text" || !next.styles[outer]) break;
      j++;
    }
    const inner = atoms.slice(i, j).map((a) => {
      const t = a as TextInline;
      const rest: Styles = { ...t.styles };
      delete rest[outer];
      return { ...t, styles: rest };
    });
    const children = build(inner);
    if (outer === "bold") out.push({ type: "strong", children });
    else if (outer === "italic") out.push({ type: "emphasis", children });
    else out.push({ type: "delete", children });
    i = j;
  }
  return out;
}

function linkNode(link: LinkInline): PhrasingContent {
  return { type: "link", url: link.href, children: build(splitBreaks(link.content)) };
}
