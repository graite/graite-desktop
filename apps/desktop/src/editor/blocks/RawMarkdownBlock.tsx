import { useEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { hasRawBlocks, toBlocks } from "@graite/md-convert";

/** Keys, clipboard and pointer events ProseMirror would otherwise take from the text box. */
const ISOLATED = [
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
  "paste",
  "cut",
  "copy",
  "drop",
  "mousedown",
  "pointerdown",
  "compositionstart",
  "compositionend",
] as const;

/**
 * Markdown the editor has no block for (HTML, footnotes, loose lists, …), kept byte-for-byte.
 * Edited as text: the source is saved as typed, and when it becomes something the editor can
 * show natively it turns into those blocks on leaving the box.
 */
export const RawMarkdown = createReactBlockSpec(
  { type: "rawMarkdown", propSchema: { source: { default: "" } }, content: "none" },
  {
    render: function Render({ block, editor }) {
      // The file keeps no trailing blank lines after a block, so neither does the box.
      const source = block.props.source.replace(/\n+$/, "");
      const [draft, setDraft] = useState(source);
      const box = useRef<HTMLTextAreaElement>(null);
      const editing = useRef(false);
      useEffect(() => {
        if (!editing.current) setDraft(source);
      }, [source]);
      useEffect(() => {
        const el = box.current;
        if (!el) return;
        const stop = (e: Event) => e.stopPropagation();
        for (const type of ISOLATED) el.addEventListener(type, stop);
        return () => {
          for (const type of ISOLATED) el.removeEventListener(type, stop);
        };
      }, []);
      useEffect(() => {
        const el = box.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }, [draft]);
      const commit = () => {
        editing.current = false;
        if (draft === source) return;
        let parsed: ReturnType<typeof toBlocks> = [];
        try {
          parsed = toBlocks(draft);
        } catch {
          /* Keep it as text. */
        }
        const native =
          parsed.length > 0 &&
          !hasRawBlocks(parsed) &&
          // Page links need the page tree to resolve; the page editor adds that on load.
          !JSON.stringify(parsed).includes('"pageLink"');
        if (native)
          editor.replaceBlocks([block.id], parsed as Parameters<typeof editor.replaceBlocks>[1]);
        else editor.updateBlock(block, { props: { source: draft } });
      };
      return (
        <div className="raw-markdown w-full" contentEditable={false}>
          <div className="raw-markdown-label">Markdown</div>
          <textarea
            ref={box}
            value={draft}
            spellCheck={false}
            readOnly={!editor.isEditable}
            aria-label="Markdown source"
            rows={1}
            onFocus={() => (editing.current = true)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
        </div>
      );
    },
  },
);
