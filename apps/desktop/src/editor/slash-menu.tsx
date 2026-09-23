import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { getDefaultReactSlashMenuItems, type DefaultReactSuggestionItem } from "@blocknote/react";
import { Columns3, LayoutList, FileText, Link2, AudioLines, Mic, ScanText } from "lucide-react";
import type { GraiteEditor } from "./schema";

export interface PickedPage {
  path: string;
  title: string;
  icon: string | null;
  /** Wikilink text: the title for a child of the current page, the full path otherwise. */
  target: string;
}

export interface SlashMenuDeps {
  /** Creates a child page on disk and returns it. */
  createChildPage: () => Promise<PickedPage>;
  /** Opens the page picker; resolves with the chosen page or null when cancelled. */
  pickPage: () => Promise<PickedPage | null>;
  /** Called after the tree changed so the sidebar can refresh. */
  onTreeChanged: () => void;
}

/** Default items we do not offer: toggle headings (we offer plain toggles only). */
const HIDDEN_DEFAULTS = /^Toggle Heading/;

export function getSlashMenuItems(
  editor: GraiteEditor,
  deps: SlashMenuDeps,
): DefaultReactSuggestionItem[] {
  const defaults = getDefaultReactSlashMenuItems(editor)
    .filter((item) => !HIDDEN_DEFAULTS.test(item.title))
    .map((item) =>
      item.title === "Toggle List"
        ? { ...item, title: "Toggle", subtext: "Collapsible block" }
        : item,
    );

  const pageItem: DefaultReactSuggestionItem = {
    title: "Page",
    subtext: "Create a sub-page",
    group: "Other",
    icon: <FileText className="size-4" />,
    onItemClick: () => {
      // Synchronous insert — must happen before any await, or BlockNote loses the position.
      const insertedBlock = insertOrUpdateBlockForSlashMenu(editor, {
        type: "pageLink",
        props: { path: "", title: "Creating…", icon: "", target: "" },
      });
      void (async () => {
        try {
          const page = await deps.createChildPage();
          editor.updateBlock(insertedBlock, {
            type: "pageLink",
            props: {
              path: page.path,
              title: page.title,
              icon: page.icon ?? "",
              target: page.target,
            },
          });
          deps.onTreeChanged();
        } catch {
          editor.removeBlocks([insertedBlock]);
        }
      })();
    },
  };

  const linkItem: DefaultReactSuggestionItem = {
    title: "Link to page",
    subtext: "Link to an existing page",
    aliases: ["link", "page link"],
    group: "Other",
    icon: <Link2 className="size-4" />,
    onItemClick: () => {
      const insertedBlock = insertOrUpdateBlockForSlashMenu(editor, {
        type: "pageLink",
        props: { path: "", title: "Choose a page…", icon: "", target: "" },
      });
      void (async () => {
        const page = await deps.pickPage();
        if (!page) {
          editor.removeBlocks([insertedBlock]);
          return;
        }
        editor.updateBlock(insertedBlock, {
          type: "pageLink",
          props: { path: page.path, title: page.title, icon: page.icon ?? "", target: page.target },
        });
      })();
    },
  };

  const mediaItems: DefaultReactSuggestionItem[] = [
    {
      title: "Audio",
      subtext: "Upload audio and transcribe it",
      aliases: ["wav", "mp3", "upload", "transcribe"],
      group: "Media",
      icon: <AudioLines className="size-4" />,
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, { type: "localMedia", props: { kind: "audio" } });
      },
    },
    {
      title: "Record audio",
      subtext: "Record your microphone to a local file",
      aliases: ["microphone", "voice", "recording"],
      group: "Media",
      icon: <Mic className="size-4" />,
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "localMedia",
          props: { kind: "recording" },
        });
      },
    },
    {
      title: "Document or image",
      subtext: "Embed a PDF or image and extract its text",
      aliases: ["pdf", "ocr", "glm", "scan", "image", "document"],
      group: "Media",
      icon: <ScanText className="size-4" />,
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, { type: "localMedia", props: { kind: "pdf" } });
      },
    },
  ];
  const layouts: DefaultReactSuggestionItem[] = ([2, 3, 4] as const).map((count) => ({
    title: `${count} columns`,
    subtext: `Arrange blocks in ${count} columns`,
    group: "Layout",
    icon: <Columns3 size={16} />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, {
        type: "columnLayout",
        props: { count },
        children: Array.from({ length: count }, () => ({
          type: "pageColumn" as const,
          children: [{ type: "paragraph" as const }],
        })),
      });
    },
  }));
  const views: DefaultReactSuggestionItem[] = (
    [
      ["table", "Table", "Nested pages with their properties as columns"],
      ["kanban", "Board", "Nested pages as cards grouped by a status"],
      ["list", "List", "Nested pages as a simple list"],
    ] as const
  ).map(([view, label, subtext]) => ({
    title: `${label} view`,
    subtext,
    aliases: [view, "view", "database"],
    group: "Views",
    icon: <LayoutList size={16} />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, { type: "pageView", props: { view } });
    },
  }));
  return [pageItem, linkItem, ...mediaItems, ...layouts, ...views, ...defaults];
}

export function filterSlashItems(items: DefaultReactSuggestionItem[], query: string) {
  const q = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      (item.subtext?.toLowerCase().includes(q) ?? false) ||
      (item.aliases?.some((a) => a.toLowerCase().includes(q)) ?? false),
  );
}
