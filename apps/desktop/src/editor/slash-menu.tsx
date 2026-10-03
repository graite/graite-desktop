import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { getDefaultReactSlashMenuItems, type DefaultReactSuggestionItem } from "@blocknote/react";
import {
  Columns3,
  LayoutList,
  FileText,
  Link2,
  AudioLines,
  Mic,
  ScanText,
  NotebookPen,
  Table2,
  FileUp,
  BarChart3,
  Code2,
} from "lucide-react";
import { toast } from "sonner";
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
  /** Copies a CSV into this page's `_data/`; resolves with the block `source` for it. */
  importTable?: (file: File) => Promise<string>;
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
      ["table", "Table", "A table of this page's subpages and their properties"],
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
  const tableItem: DefaultReactSuggestionItem = {
    title: "Database table",
    subtext: "Typed columns saved as a CSV in this page; filter, sort and edit like a spreadsheet",
    aliases: ["csv", "table", "database", "spreadsheet", "data", "grid", "rows"],
    group: "Views",
    icon: <Table2 size={16} />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, { type: "tableView", props: { source: "" } });
    },
  };
  const chartItem: DefaultReactSuggestionItem = {
    title: "Chart",
    subtext: "Bar, line, pie or a number from this page's tables, updated as rows change",
    aliases: ["chart", "graph", "plot", "bar", "line", "pie", "kpi", "visual"],
    group: "Views",
    icon: <BarChart3 size={16} />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, { type: "chart", props: { source: "" } });
    },
  };
  const dashboardItem: DefaultReactSuggestionItem = {
    title: "HTML",
    subtext: "Upload an HTML file or create a report or dashboard with the page’s AI chat",
    aliases: ["dashboard", "html", "report", "overview", "kpi", "panel"],
    group: "Views",
    icon: <Code2 size={16} />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, { type: "dashboard", props: { src: "" } });
    },
  };
  const importItem: DefaultReactSuggestionItem | null = deps.importTable
    ? {
        title: "Import CSV",
        subtext: "Turn a .csv file into a table on this page",
        aliases: ["csv", "import", "spreadsheet", "excel", "upload"],
        group: "Views",
        icon: <FileUp size={16} />,
        onItemClick: () => {
          // Insert now (BlockNote loses the position after an await), then choose the file.
          const inserted = insertOrUpdateBlockForSlashMenu(editor, {
            type: "tableView",
            props: { source: "" },
          });
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".csv,text/csv";
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            deps.importTable!(file).then(
              (source) => editor.updateBlock(inserted, { type: "tableView", props: { source } }),
              (e: Error) => toast.error(e.message),
            );
          };
          // Still inside the click, so the browser lets the file dialog open.
          input.click();
        },
      }
    : null;
  const calloutItem: DefaultReactSuggestionItem = {
    title: "Callout",
    subtext: "Highlighted note (Obsidian callout)",
    group: "Basic blocks",
    icon: <NotebookPen className="size-4" />,
    aliases: ["note", "warning", "tip", "admonition"],
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, { type: "callout", props: { kind: "note" } });
    },
  };
  // Keep it with the other basic blocks: right after the last default of that group.
  const basic = defaults.map((item) => item.group).lastIndexOf("Basic blocks");
  const withCallout =
    basic < 0
      ? [...defaults, calloutItem]
      : [...defaults.slice(0, basic + 1), calloutItem, ...defaults.slice(basic + 1)];
  return [
    pageItem,
    linkItem,
    ...mediaItems,
    ...layouts,
    ...views,
    tableItem,
    ...(importItem ? [importItem] : []),
    chartItem,
    dashboardItem,
    ...withCallout,
  ];
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
