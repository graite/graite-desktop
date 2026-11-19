import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey } from "prosemirror-state";

/**
 * Typing `->` gives a `→`. Not in code (code blocks and inline code keep what was typed), and
 * Backspace right after the swap puts `->` back, for the times the two characters were meant.
 */
const KEY = new PluginKey<{ from: number } | null>("graite-arrows");
export const ARROW = "→";

export const Arrows = createExtension(() => ({
  key: "arrows",
  prosemirrorPlugins: [
    new Plugin<{ from: number } | null>({
      key: KEY,
      state: {
        init: () => null,
        // Only the transaction that made the arrow can be undone with Backspace.
        apply: (tr, value) =>
          (tr.getMeta(KEY) as { from: number } | undefined) ??
          (tr.docChanged || tr.selectionSet ? null : value),
      },
      props: {
        handleTextInput(view, from, to, text) {
          if (text !== ">" || from !== to || from < 1) return false;
          const { state } = view;
          const $from = state.doc.resolve(from);
          if ($from.parent.type.spec.code || $from.parent.type.name === "codeBlock") return false;
          if ($from.marks().some((mark) => mark.type.spec.code || mark.type.name === "code"))
            return false;
          if (state.doc.textBetween(from - 1, from) !== "-") return false;
          const tr = state.tr.insertText(ARROW, from - 1, to);
          view.dispatch(tr.setMeta(KEY, { from: from - 1 }));
          return true;
        },
        handleKeyDown(view, event) {
          if (event.key !== "Backspace") return false;
          const made = KEY.getState(view.state);
          const { selection } = view.state;
          if (!made || !selection.empty || selection.from !== made.from + 1) return false;
          if (view.state.doc.textBetween(made.from, made.from + 1) !== ARROW) return false;
          view.dispatch(view.state.tr.insertText("->", made.from, made.from + 1));
          return true;
        },
      },
    }),
  ],
}));
