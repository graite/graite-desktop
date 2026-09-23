import { useEffect, useRef } from "react";
import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/shadcn";
import {
  BasicTextStyleButton,
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { Bold, Heading1, Heading2, Heading3, Italic, List, Type } from "lucide-react";
import { fromBlocks, toBlocks } from "@graite/md-convert";
import { schema, type GraiteEditor, type GraitePartialBlock } from "./schema";
import { filterSlashItems } from "./slash-menu";
import { markdownPasteHandler } from "./paste";
import "@blocknote/shadcn/style.css";
import "./editor.css";

export function textInstructionItems(editor: GraiteEditor): DefaultReactSuggestionItem[] {
  return [
    {
      title: "Text",
      icon: <Type size={16} />,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "paragraph" }),
    },
    ...([1, 2, 3] as const).map((level, i) => ({
      title: `Heading ${level}`,
      icon: [<Heading1 size={16} />, <Heading2 size={16} />, <Heading3 size={16} />][i],
      onItemClick: () =>
        insertOrUpdateBlockForSlashMenu(editor, { type: "heading", props: { level } }),
    })),
    {
      title: "Bullet list",
      icon: <List size={16} />,
      aliases: ["bullet", "list"],
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "bulletListItem" }),
    },
    {
      title: "Bold",
      icon: <Bold size={16} />,
      onItemClick: () => {
        editor.toggleStyles({ bold: true });
        editor.focus();
      },
    },
    {
      title: "Italic",
      icon: <Italic size={16} />,
      onItemClick: () => {
        editor.toggleStyles({ italic: true });
        editor.focus();
      },
    },
  ].map((item) => ({ ...item, group: "Text" }));
}

function blocks(value: string): GraitePartialBlock[] {
  const parsed = toBlocks(value) as GraitePartialBlock[];
  return parsed.length ? parsed : [{ type: "paragraph" }];
}

/** Shares the page renderer and lossless Markdown conversion, with text-only controls. */
export function TextInstructionsEditor({
  value,
  onChange,
  label = "Instructions",
  readOnly = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  label?: string;
  readOnly?: boolean;
}) {
  const editor = useCreateBlockNote({
    schema,
    initialContent: blocks(value),
    pasteHandler: markdownPasteHandler(),
    domAttributes: { editor: { "aria-label": label } },
  });
  const last = useRef(value);
  const syncing = useRef(false);
  useEffect(() => {
    if (last.current === value) return;
    syncing.current = true;
    editor.replaceBlocks(editor.document, blocks(value));
    last.current = value;
    syncing.current = false;
  }, [value, editor]);
  return (
    <div className="text-instructions-editor" data-readonly={readOnly || undefined}>
      <BlockNoteView
        editor={editor}
        theme="light"
        editable={!readOnly}
        slashMenu={false}
        sideMenu={false}
        formattingToolbar={false}
        linkToolbar={false}
        tableHandles={false}
        onChange={() => {
          if (syncing.current || readOnly) return;
          const next = fromBlocks(editor.document as unknown as Parameters<typeof fromBlocks>[0]);
          last.current = next;
          onChange?.(next);
        }}
      >
        {!readOnly && (
          <>
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async (query) => filterSlashItems(textInstructionItems(editor), query)}
            />
            <FormattingToolbarController
              formattingToolbar={() => (
                <FormattingToolbar>
                  <BasicTextStyleButton basicTextStyle="bold" />
                  <BasicTextStyleButton basicTextStyle="italic" />
                </FormattingToolbar>
              )}
            />
          </>
        )}
      </BlockNoteView>
    </div>
  );
}
