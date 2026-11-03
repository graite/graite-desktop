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
  Kanban,
  Database,
  FileStack,
  FileUp,
  BarChart3,
  Code2,
} from "lucide-react";
import { toast } from "sonner";
import type { GraiteEditor } from "./schema";
import { startSetup, type SetupMode } from "./tables/setup";

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
  /** Creates an Untitled child page holding an empty database (D82) and returns it. */
  createDatabasePage?: () => Promise<PickedPage>;
  /** Opens a page. */
  navigate?: (path: string) => void;
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
  // Subpages (pages with properties) and databases (rows in a CSV) are different things, so
  // they are separate groups with plain names (D82).
  const views: DefaultReactSuggestionItem[] = (
    [
      ["table", "table", "Your subpages and their properties in a table", Table2],
      ["kanban", "board", "Your subpages as cards, grouped by a status", Kanban],
      ["list", "list", "Your subpages as a simple list", LayoutList],
    ] as const
  ).map(([view, label, subtext, Icon]) => ({
    title: `Subpages as ${label}`,
    subtext,
    aliases: [view, label, "view", "subpages", "children", "pages"],
    group: "Subpages",
    icon: <Icon size={16} />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, { type: "pageView", props: { view } });
    },
  }));
  const database = (mode: SetupMode) => () => {
    const block = insertOrUpdateBlockForSlashMenu(editor, {
      type: "tableView",
      props: { source: "" },
    });
    startSetup(block.id, mode);
  };
  // Like "Page": made at once (an Untitled page with an empty table) and opened.
  const databasePageItem: DefaultReactSuggestionItem | null = deps.createDatabasePage
    ? {
        title: "Database page",
        subtext: "A new page holding a database; opens right away",
        aliases: ["database", "full page", "table page", "data", "new page"],
        group: "Database",
        icon: <FileStack size={16} />,
        onItemClick: () => {
          // Synchronous insert: BlockNote loses the position after an await.
          const inserted = insertOrUpdateBlockForSlashMenu(editor, {
            type: "pageLink",
            props: { path: "", title: "Creating…", icon: "", target: "" },
          });
          void (async () => {
            try {
              const page = await deps.createDatabasePage!();
              editor.updateBlock(inserted, {
                type: "pageLink",
                props: {
                  path: page.path,
                  title: page.title,
                  icon: page.icon ?? "",
                  target: page.target,
                },
              });
              deps.onTreeChanged();
              deps.navigate?.(page.path);
            } catch (e) {
              editor.removeBlocks([inserted]);
              toast.error(`Could not create the database page: ${(e as Error).message}`);
            }
          })();
        },
      }
    : null;
  const databaseItems: DefaultReactSuggestionItem[] = [
    ...(databasePageItem ? [databasePageItem] : []),
    {
      title: "Database",
      subtext:
        "Rows with typed fields, shown as a table, board or list; can link to other databases",
      aliases: [
        "database",
        "table",
        "board",
        "kanban",
        "list",
        "csv",
        "spreadsheet",
        "data",
        "rows",
      ],
      group: "Database",
      icon: <Database size={16} />,
      onItemClick: database("new"),
    },
    {
      title: "Linked view of a database",
      subtext: "Show a database that already exists, as a table, board or list",
      aliases: ["linked", "view", "existing", "database", "table", "board", "kanban"],
      group: "Database",
      icon: <Link2 size={16} />,
      onItemClick: database("linked"),
    },
  ];
  const chartItem: DefaultReactSuggestionItem = {
    title: "Chart",
    subtext: "Bar, line, pie or a number from a database, updated as rows change",
    aliases: ["chart", "graph", "plot", "bar", "line", "pie", "kpi", "visual"],
    group: "Database",
    icon: <BarChart3 size={16} />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, { type: "chart", props: { source: "" } });
    },
  };
  const dashboardItem: DefaultReactSuggestionItem = {
    title: "HTML",
    subtext: "Upload an HTML file or create a report or dashboard with the page’s AI chat",
    aliases: ["dashboard", "html", "report", "overview", "kpi", "panel"],
    group: "Database",
    icon: <Code2 size={16} />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, { type: "dashboard", props: { src: "" } });
    },
  };
  const importItem: DefaultReactSuggestionItem | null = deps.importTable
    ? {
        title: "Import CSV",
        subtext: "Turn a .csv file into a database on this page",
        aliases: ["csv", "import", "spreadsheet", "excel", "upload"],
        group: "Database",
        icon: <FileUp size={16} />,
        onItemClick: () => {
          // Insert now (BlockNote loses the position after an await), then choose the file.
          const inserted = insertOrUpdateBlockForSlashMenu(editor, {
            type: "tableView",
            props: { source: "" },
          });
          const views = (source: string) =>
            JSON.stringify([{ name: "Table", source, view: "table" }]);
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".csv,text/csv";
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            deps.importTable!(file).then(
              (source) =>
                editor.updateBlock(inserted, {
                  type: "tableView",
                  props: { views: views(source) },
                }),
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
    ...databaseItems,
    ...(importItem ? [importItem] : []),
    chartItem,
    dashboardItem,
    ...views,
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
