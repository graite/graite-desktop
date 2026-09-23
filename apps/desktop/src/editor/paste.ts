import type { BlockNoteEditorOptions } from "@blocknote/core";
import { toBlocks } from "@graite/md-convert";
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
// HTML that already carries structure (a web page, a rich editor): BlockNote converts that well.
const STRUCTURED_HTML = /<(h[1-6]|ul|ol|li|table|blockquote|pre)\b/i;
// Clipboard formats BlockNote's own handler knows better than Markdown.
const NATIVE_TYPES = ["blocknote/html", "vscode-editor-data", "Files"];

/** Plain text such as a Notepad copy that has Markdown block syntax in it. */
export function looksLikeMarkdownBlocks(text: string): boolean {
  return BLOCK_LINE.test(text.replace(/\r\n?/g, "\n"));
}

/**
 * Paste plain-text Markdown through our converter, so a single `# Heading` or `- item`
 * becomes a block (BlockNote's own detector wants more text) and wikilinks, callouts and
 * graite fences come out exactly as they do when a page loads.
 */
export function markdownPasteHandler(
  hydrate: (blocks: GraitePartialBlock[]) => GraitePartialBlock[] = (b) => b,
): PasteHandler {
  return ({ event, editor, defaultPasteHandler }) => {
    const data = event.clipboardData;
    if (!data || NATIVE_TYPES.some((t) => data.types.includes(t))) return defaultPasteHandler();
    const text = data.getData("text/plain");
    if (!text || !looksLikeMarkdownBlocks(text)) return defaultPasteHandler();
    if (STRUCTURED_HTML.test(data.getData("text/html"))) return defaultPasteHandler();
    if (editor.getTextCursorPosition().block.type === "codeBlock") return defaultPasteHandler();

    const blocks = hydrate(toBlocks(text.replace(/\r\n?/g, "\n")) as GraitePartialBlock[]);
    if (!blocks.length) return defaultPasteHandler();

    editor.transact((tr) => {
      if (!tr.selection.empty) tr.deleteSelection();
    });
    const current = editor.getTextCursorPosition().block as GraiteBlock;
    const empty =
      current.type === "paragraph" &&
      Array.isArray(current.content) &&
      current.content.length === 0 &&
      !current.children.length;
    const inserted = empty
      ? editor.replaceBlocks([current], blocks).insertedBlocks
      : editor.insertBlocks(blocks, current, "after");
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
