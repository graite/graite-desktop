import { expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { schema, type GraiteEditor } from "../schema";
import { EditorSurface } from "../EditorSurface";
it("exposes the native column containers used by the grid layout", () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [
      {
        type: "columnLayout",
        props: { count: 2 },
        children: [
          { type: "pageColumn", children: [{ type: "paragraph", content: "Left" }] },
          { type: "pageColumn", children: [{ type: "paragraph", content: "Right" }] },
        ],
      },
    ],
  }) as GraiteEditor;
  render(
    <EditorSurface
      editor={editor}
      onChange={() => {}}
      slashDeps={{
        createChildPage: async () => {
          throw Error();
        },
        pickPage: async () => null,
        onTreeChanged: () => {},
      }}
    />,
  );
  expect(
    editor.prosemirrorView.dom.querySelectorAll(
      ".bn-block:has(> .node-columnLayout) > .bn-block-group > .bn-block-outer",
    ),
  ).toHaveLength(2);
  expect(
    editor.prosemirrorView.dom.querySelectorAll(
      ".bn-block:has(> .node-pageColumn) > .bn-block-group .bn-inline-content",
    ),
  ).toHaveLength(2);
  cleanup();
});
