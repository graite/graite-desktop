import { useRef, useState, type DragEvent } from "react";
import {
  ArrowUp,
  Plus,
  Square,
  ChevronDown,
  FileUp,
  MessageCircle,
  PenLine,
  MousePointer2,
  Check,
  Telescope,
  AtSign,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAutoGrow } from "@/chat/useAutoGrow";
import type { Attachment, ChatMode } from "@/lib/ai";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerModel } from "./ComposerModel";
import { useDepth } from "./depth";
import { SearchHelp } from "./SearchHelp";
import { knownMentionPages, loadMentionPages, mentionAt, mentionMatches } from "./mentions";
import { AttachmentChips } from "./AttachmentChips";

export const MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: "ask", label: "Ask", hint: "Answer from your pages; add pages or cards when asked" },
  { id: "draft", label: "Draft", hint: "Write something grounded in your pages" },
  { id: "act", label: "Act", hint: "Propose changes to your pages for review" },
];

export const ACCEPT = ".pdf,.md,.txt,image/png,image/jpeg,image/webp,image/tiff";

/** The message box: grows to 8 lines then scrolls, takes attachments, picks a mode. */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
  mode,
  onModeChange,
  attachments,
  onAttach,
  onRemoveAttachment,
  placeholder = "Ask about your pages…",
  left,
  footnote,
  actEnabled = true,
  fixedMode = false,
  contextId,
  pages,
  onSettings,
  settingsVersion,
  onModelChanged,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  attachments: Attachment[];
  onAttach: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  placeholder?: string;
  left?: React.ReactNode;
  footnote?: React.ReactNode;
  actEnabled?: boolean;
  /** The mode is decided elsewhere (the assistant's settings): hide the picker. */
  fixedMode?: boolean;
  contextId?: string;
  /** The page selection for this chat (a `ScopeMenu`), shown beside the mode. */
  pages?: React.ReactNode;
  onSettings?: () => void;
  settingsVersion?: number;
  onModelChanged?: () => void;
}) {
  const [depth, setDepth] = useDepth();
  // `@` in the message opens a list of pages; the one picked is pinned for this question.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionPages, setMentionPages] = useState(knownMentionPages);
  const [mentionIndex, setMentionIndex] = useState(0);
  const suggestions = mention ? mentionMatches(mention.query, mentionPages) : [];
  const trackMention = (text: string, cursor: number) => {
    const next = mentionAt(text, cursor);
    setMention(next);
    setMentionIndex(0);
    if (next) void loadMentionPages().then(setMentionPages);
  };
  const pickMention = (page: { title: string }) => {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    onChange(`${value.slice(0, mention.start)}@${page.title} ${value.slice(end)}`);
    setMention(null);
  };
  const [working, setWorking] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  useAutoGrow(area, value, 8);
  const drop = (event: DragEvent<HTMLFormElement>) => {
    if (busy || disabled || working || !event.dataTransfer.files.length) return;
    event.preventDefault();
    setDropping(false);
    onAttach(event.dataTransfer.files);
  };
  return (
    <form
      className="ai-composer"
      data-dropping={dropping || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !disabled && !working && value.trim()) onSend();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={drop}
    >
      <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />
      {mention && suggestions.length > 0 && (
        <ul className="ai-mention-list" role="listbox" aria-label="Pages to mention">
          {suggestions.map((page, i) => (
            <li
              key={page.path}
              role="option"
              aria-selected={i === mentionIndex}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the cursor in the message box
                pickMention(page);
              }}
              onMouseMove={() => setMentionIndex(i)}
            >
              <AtSign size={12} />
              <span>{page.title}</span>
              {page.breadcrumb && <small>{page.breadcrumb}</small>}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={area}
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        rows={1}
        onChange={(e) => {
          onChange(e.target.value);
          trackMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={(e) => {
          if (mention && suggestions.length) {
            // The page list is open: the arrow keys and Enter belong to it.
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setMentionIndex((i) => (i + step + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pickMention(suggestions[mentionIndex] ?? suggestions[0]!);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            // Enter while an answer is streaming (or with an empty box) must keep the draft.
            if (!busy && !disabled && !working && value.trim()) onSend();
          }
        }}
      />
      <div>
        <div className="ai-composer-left">
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept={ACCEPT}
            aria-label="Add attachments"
            onChange={(e) => {
              if (e.target.files?.length) onAttach(e.target.files);
              e.target.value = "";
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="ai-composer-icon"
                aria-label="Add context"
                disabled={busy || disabled || working}
              >
                <Plus size={19} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-52">
              <DropdownMenuItem onSelect={() => input.current?.click()}>
                <FileUp size={16} />
                Files
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!fixedMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="ai-composer-mode"
                  aria-label="Answer mode"
                  disabled={busy || disabled || working}
                >
                  <ChevronDown size={13} />
                  {MODES.find((m) => m.id === mode)?.label}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="min-w-64">
                {MODES.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    disabled={m.id === "act" && !actEnabled}
                    onSelect={() => onModeChange(m.id)}
                    title={m.hint}
                  >
                    {m.id === "ask" ? (
                      <MessageCircle size={16} />
                    ) : m.id === "draft" ? (
                      <PenLine size={16} />
                    ) : (
                      <MousePointer2 size={16} />
                    )}
                    <span className="flex-1">
                      <span className="block">{m.label}</span>
                      <span className="text-xs text-muted-foreground">{m.hint}</span>
                    </span>
                    {mode === m.id && <Check size={14} />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!fixedMode && mode === "ask" && (
            <button
              type="button"
              className="ai-composer-mode ai-composer-depth"
              aria-pressed={depth === "deep"}
              aria-label="Deep research"
              title={
                depth === "deep"
                  ? "Deep research is on: several searches in small steps, a fuller answer, slower. Click for a quick answer."
                  : "Quick answer: one search, answered from the best passages. Click for deep research."
              }
              disabled={busy || disabled || working}
              onClick={() => setDepth(depth === "deep" ? "quick" : "deep")}
            >
              <Telescope size={13} />
              {depth === "deep" ? "Deep" : "Quick"}
            </button>
          )}
          {pages}
          {left}
        </div>
        <div className="ai-composer-right">
          {!fixedMode && <SearchHelp />}
          <ComposerModel
            contextId={contextId}
            busy={busy || !!disabled}
            working={working}
            onWorking={setWorking}
            value={value}
            onChange={onChange}
            onSettings={onSettings}
            settingsVersion={settingsVersion}
            onModelChanged={onModelChanged}
          />
          {busy ? (
            <Button
              className="ai-send"
              size="icon"
              type="button"
              title="Stop answer"
              aria-label="Stop answer"
              onClick={onStop}
            >
              <Square size={13} />
            </Button>
          ) : (
            <Button
              className="ai-send"
              size="icon"
              title="Send message"
              aria-label="Send message"
              disabled={!value.trim() || disabled || working}
            >
              <ArrowUp size={17} />
            </Button>
          )}
        </div>
      </div>
      {footnote}
    </form>
  );
}
