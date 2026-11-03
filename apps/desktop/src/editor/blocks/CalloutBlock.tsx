import { createReactBlockSpec } from "@blocknote/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertTriangle,
  CircleHelp,
  Flame,
  Info,
  Lightbulb,
  NotebookPen,
  Quote,
} from "lucide-react";

/** Obsidian callout kinds grouped by look; any other kind renders like a note. */
const LOOKS: Record<string, { tone: string; Icon: typeof Info }> = {
  note: { tone: "blue", Icon: NotebookPen },
  info: { tone: "blue", Icon: Info },
  abstract: { tone: "teal", Icon: NotebookPen },
  summary: { tone: "teal", Icon: NotebookPen },
  tldr: { tone: "teal", Icon: NotebookPen },
  tip: { tone: "teal", Icon: Lightbulb },
  hint: { tone: "teal", Icon: Lightbulb },
  important: { tone: "teal", Icon: Flame },
  success: { tone: "green", Icon: Info },
  check: { tone: "green", Icon: Info },
  done: { tone: "green", Icon: Info },
  question: { tone: "yellow", Icon: CircleHelp },
  help: { tone: "yellow", Icon: CircleHelp },
  faq: { tone: "yellow", Icon: CircleHelp },
  warning: { tone: "orange", Icon: AlertTriangle },
  caution: { tone: "orange", Icon: AlertTriangle },
  attention: { tone: "orange", Icon: AlertTriangle },
  failure: { tone: "red", Icon: AlertTriangle },
  danger: { tone: "red", Icon: AlertTriangle },
  error: { tone: "red", Icon: AlertTriangle },
  bug: { tone: "red", Icon: AlertTriangle },
  example: { tone: "purple", Icon: NotebookPen },
  quote: { tone: "gray", Icon: Quote },
  cite: { tone: "gray", Icon: Quote },
};

/** The kinds offered when changing a callout; any Obsidian kind is still read and kept. */
const CHOICES: [string, string][] = [
  ["note", "Note"],
  ["info", "Info"],
  ["tip", "Tip"],
  ["success", "Success"],
  ["question", "Question"],
  ["warning", "Warning"],
  ["danger", "Danger"],
  ["quote", "Quote"],
];

/**
 * An Obsidian callout (`> [!note] Title` + body). The inline content is the title; the body is
 * the block's children, which BlockNote nests under it. Saved back as the same callout.
 */
export const Callout = createReactBlockSpec(
  {
    type: "callout",
    propSchema: { kind: { default: "note" }, folded: { default: "" } },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const kind = block.props.kind.toLowerCase();
      const { tone, Icon } = LOOKS[kind] ?? LOOKS.note!;
      return (
        <div className="graite-callout" data-tone={tone}>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="graite-callout-icon"
              contentEditable={false}
              title={`${kind[0]?.toUpperCase()}${kind.slice(1)} · click to change`}
              aria-label="Callout kind"
            >
              <Icon size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
              {CHOICES.map(([value, label]) => {
                const Choice = LOOKS[value]!.Icon;
                return (
                  <DropdownMenuItem
                    key={value}
                    onSelect={() => editor.updateBlock(block, { props: { kind: value } })}
                  >
                    <Choice className="size-4" /> {label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="graite-callout-title" ref={contentRef} />
        </div>
      );
    },
  },
);
