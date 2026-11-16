import type { BlockNoteEditorOptions } from "@blocknote/core";
import { toBlocksSafe } from "@graite/md-convert";
import type { GraiteBlock, GraitePartialBlock, schema } from "./schema";

type S = typeof schema;
type PasteHandler = NonNullable<
  BlockNoteEditorOptions<
    S["blockSchema"],
    S["inlineContentSchema"],
    S["styleSchema"]
  >["pasteHandler"]
>;

// A line that starts a Markdown block: heading, bullet, numbered item, task, quote, fence or table row.
const BLOCK_LINE =
  /^ {0,3}(#{1,6}[ \t]+\S|[-*+][ \t]+\S|\d{1,9}[.)][ \t]+\S|>|```|~~~|\|.*\|[ \t]*$)/m;
// Inline Markdown in otherwise plain text: strong, strikethrough, code, a link or a wikilink.
const INLINE_MARK =
  /(\*\*|__)\S(.*?\S)?\1|~~\S(.*?\S)?~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\[\[[^\]\n]+\]\]/;
// HTML that carries real structure (a web page, a rich editor): BlockNote converts that well.
// `<pre>` alone is not structure: editors, terminals and chat apps wrap any copied text in it.
const STRUCTURED_HTML = /<(h[1-6]|ul|ol|li|table|blockquote)\b/i;
// Clipboard formats BlockNote's own handler knows better than Markdown.
const NATIVE_TYPES = ["blocknote/html", "Files"];
// What VS Code and its forks call the languages whose text is Markdown or plain prose.
const PROSE_MODES = new Set(["markdown", "mdx", "plaintext", "text", ""]);

/** Plain text such as a Notepad copy that has Markdown block syntax in it. */
export function looksLikeMarkdownBlocks(text: string): boolean {
  return BLOCK_LINE.test(text.replace(/\r\n?/g, "\n"));
}

/** Text whose only Markdown is inline: `**bold**`, a link, `code`. */
export function looksLikeInlineMarkdown(text: string): boolean {
  return INLINE_MARK.test(text);
}

/** Remove the indentation every non-empty line shares (a block copied from inside a list or code). */
export function dedent(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return common ? lines.map((l) => l.slice(common)).join("\n") : lines.join("\n");
}

/** True when a copy from VS Code (or Cursor) is source code, which belongs in a code block. */
function isCodeCopy(data: DataTransfer): boolean {
  if (!data.types.includes("vscode-editor-data")) return false;
  try {
    const mode = (JSON.parse(data.getData("vscode-editor-data")) as { mode?: string }).mode ?? "";
    return !PROSE_MODES.has(mode.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * A second try for Markdown the converter keeps as a raw block because it could not write it
 * back unchanged. A paste has nothing to write back, so loose lists are tightened, explicit
 * left alignment is dropped from tables and fence attributes are removed.
 */
function relaxed(source: string): string {
  const lines = source.split("\n");
  if (/^ {0,3}([-*+]|\d{1,9}[.)])[ \t]/.test(lines[0] ?? "")) {
    return lines
      .filter((line, i) => line.trim() || /^```|^~~~/.test(lines[i - 1] ?? ""))
      .join("\n");
  }
  if (/^\s*\|/.test(lines[0] ?? "") && lines[1]) {
    lines[1] = lines[1].replace(/:(-+)(?!:)/g, "-$1");
    return lines.join("\n");
  }
  if (/^(```|~~~)/.test(lines[0] ?? "")) {
    lines[0] = lines[0]!.replace(/^(```+|~~~+)\s*([\w+#.-]*).*$/, "$1$2");
    return lines.join("\n");
  }
  return source;
}

/** Pasted Markdown as blocks, with as few raw Markdown blocks as the converter allows. */
export function pastedBlocks(text: string): GraitePartialBlock[] {
  const blocks = toBlocksSafe(dedent(text).replace(/^\n+|\s+$/g, "")) as GraitePartialBlock[];
  return blocks.flatMap((block) => {
    if (block.type !== "rawMarkdown") return [block];
    const source = String(block.props?.source ?? "");
    const again = toBlocksSafe(relaxed(source)) as GraitePartialBlock[];
    return again.length && again.every((b) => b.type !== "rawMarkdown") ? again : [block];
  });
}

/**
 * Paste plain-text Markdown through our converter, so headings, lists, tables, bold and links
 * become styled blocks, and wikilinks, callouts and graite fences come out exactly as they do
 * when a page loads. Rich HTML, files and source code are left to BlockNote.
 */
export function markdownPasteHandler(
  hydrate: (blocks: GraitePartialBlock[]) => GraitePartialBlock[] = (b) => b,
): PasteHandler {
  return ({ event, editor, defaultPasteHandler }) => {
    const data = event.clipboardData;
    if (!data || NATIVE_TYPES.some((t) => data.types.includes(t))) return defaultPasteHandler();
    const text = dedent(data.getData("text/plain"));
    const blockLevel = looksLikeMarkdownBlocks(text);
    if (!text.trim() || (!blockLevel && !looksLikeInlineMarkdown(text)))
      return defaultPasteHandler();
    if (STRUCTURED_HTML.test(data.getData("text/html"))) return defaultPasteHandler();
    if (isCodeCopy(data)) return defaultPasteHandler();
    if (editor.getTextCursorPosition().block.type === "codeBlock") return defaultPasteHandler();

    const blocks = hydrate(pastedBlocks(text));
    if (!blocks.length) return defaultPasteHandler();

    editor.transact((tr) => {
      if (!tr.selection.empty) tr.deleteSelection();
    });
    const only = blocks.length === 1 ? blocks[0]! : undefined;
    if (only?.type === "paragraph" && Array.isArray(only.content)) {
      // One line of text with inline Markdown goes in at the cursor, like typed text.
      try {
        editor.insertInlineContent(only.content as never);
        return true;
      } catch {
        /* the cursor is not in a text block: insert as a block below */
      }
    }
    let current = editor.getTextCursorPosition().block as GraiteBlock;
    const empty =
      current.type === "paragraph" &&
      Array.isArray(current.content) &&
      current.content.length === 0 &&
      !current.children.length;
    let placement: "before" | "after" = "after";
    if (!empty && Array.isArray(current.content)) {
      // In the middle of a line the paste goes between its two halves; at its start, above it.
      const cursor = editor.transact((tr) => {
        const { $from } = tr.selection;
        return { offset: $from.parentOffset, size: $from.parent.content.size, pos: $from.pos };
      });
      if (cursor.offset === 0 && cursor.size > 0) placement = "before";
      else if (cursor.offset > 0 && cursor.offset < cursor.size) {
        try {
          editor.transact((tr) => tr.split(cursor.pos, 2));
          current = editor.getPrevBlock(editor.getTextCursorPosition().block) as GraiteBlock;
        } catch {
          /* cannot split here (a table cell): insert below */
        }
      }
    }
    const inserted = empty
      ? editor.replaceBlocks([current], blocks).insertedBlocks
      : editor.insertBlocks(blocks, current, placement);
    const last = inserted[inserted.length - 1];
    // Blocks without text (a view, an image) cannot hold the cursor; leave it where it was.
    try {
      if (last) editor.setTextCursorPosition(last, "end");
    } catch {
      /* no inline content */
    }
    return true;
  };
}
