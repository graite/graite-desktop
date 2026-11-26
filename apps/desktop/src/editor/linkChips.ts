import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

const BARE_URL = /^https?:\/\/[^\s<>"']+$/i;
const LABEL_PART = 40;

/** The text when it is one web address and nothing else, otherwise null. */
export function bareUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!BARE_URL.test(trimmed)) return null;
  try {
    return new URL(trimmed).hostname ? trimmed : null;
  } catch {
    return null;
  }
}

/** A web address with `https://` added when only a domain was typed; null when it is none. */
export function normalizeUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return (
    bareUrl(trimmed) ??
    (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(trimmed) ? bareUrl(`https://${trimmed}`) : null)
  );
}

/**
 * A short name for a web address, made without fetching anything: the site, and the last
 * part of the path when there is one ("github.com › graite"). It is what a pasted address
 * shows as; the full address stays the link's target.
 */
export function linkLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const parts = parsed.pathname.split("/").filter(Boolean);
  let last = parts[parts.length - 1] ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    /* keep it as written */
  }
  last = last
    .replace(/\.(html?|php|aspx?)$/i, "")
    .replace(/[-_+]+/g, " ")
    .trim();
  if (last.length > LABEL_PART) last = last.slice(0, LABEL_PART - 1).trimEnd() + "…";
  return last ? `${host} › ${last}` : host;
}

type ProseMirrorNode = EditorState["doc"];
const KEY = new PluginKey<DecorationSet>("graite-link-chips");

function build(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const link = node.marks.find((mark) => mark.type.name === "link");
    const href = link ? String((link.attrs as { href?: string }).href ?? "") : "";
    if (!href || !/^https?:/i.test(href)) return;
    // A link that still carries its generated short name, or the bare address itself.
    if (node.text !== linkLabel(href) && node.text !== href) return;
    decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: "link-chip" }));
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Web links whose text is the short name of their address (or the address itself) are drawn
 * as a compact chip. This is a decoration: the page still holds an ordinary Markdown link,
 * and a link the user gave words of their own stays plain text.
 */
export const LinkChips = createExtension(() => ({
  key: "linkChips",
  prosemirrorPlugins: [
    new Plugin<DecorationSet>({
      key: KEY,
      state: {
        init: (_, state) => build(state.doc),
        apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
      },
      props: { decorations: (state) => KEY.getState(state) },
    }),
  ],
}));
