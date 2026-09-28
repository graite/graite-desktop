import { expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { toBlocks } from "@graite/md-convert";
import { schema, type GraiteEditor, type GraitePartialBlock } from "../schema";
import { isolateUnloadable } from "../PageEditor";

it("turns only the block the editor refuses into editable Markdown", () => {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  const body = "# Title\n\nKept text.\n\nBroken part.\n";
  const blocks = toBlocks(body) as GraitePartialBlock[];
  // A block type the schema does not know, as a converter bug would produce.
  blocks[2] = { type: "notABlock" } as unknown as GraitePartialBlock;
  const safe = isolateUnloadable(editor, blocks, body);
  expect(safe.map((b) => b.type)).toEqual(["heading", "paragraph", "rawMarkdown"]);
  expect(safe[2]!.props).toEqual({ source: "Broken part." });
});
