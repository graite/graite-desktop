import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { TextInstructionsEditor, textInstructionItems } from "../TextInstructionsEditor";
import { schema } from "../schema";

const rect = () => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  toJSON() {
    return this;
  },
});
Element.prototype.getBoundingClientRect = rect as never;
Element.prototype.getClientRects = (() => [] as unknown as DOMRectList) as never;
Range.prototype.getBoundingClientRect = rect as never;
Range.prototype.getClientRects = (() => [] as unknown as DOMRectList) as never;
afterEach(cleanup);

it("renders Markdown as a page without rewriting it on open", () => {
  const change = vi.fn();
  render(
    <TextInstructionsEditor
      value={"## New contacts\n\n- Include **name** and *email*.\n"}
      onChange={change}
    />,
  );
  expect(screen.getByRole("heading", { name: "New contacts" })).toBeTruthy();
  expect(screen.getByText("name").tagName).toBe("STRONG");
  expect(screen.getByText("email").tagName).toBe("EM");
  expect(change).not.toHaveBeenCalled();
});
it("limits slash commands to text formatting and inserts a heading", () => {
  const editor = BlockNoteEditor.create({ schema });
  const items = textInstructionItems(editor);
  expect(items.map((i) => i.title)).toEqual([
    "Text",
    "Heading 1",
    "Heading 2",
    "Heading 3",
    "Bullet list",
    "Bold",
    "Italic",
  ]);
  items[2].onItemClick();
  expect(editor.document[0]).toMatchObject({ type: "heading", props: { level: 2 } });
});
it("makes inherited instructions read-only", () => {
  const { container } = render(<TextInstructionsEditor value="Read only." readOnly />);
  expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  expect(screen.getByText("Read only.")).toBeTruthy();
});
