import { useCallback, useEffect, useRef, useState } from "react";
import { Orbit, Paperclip, PenLine, X } from "lucide-react";
import { toast } from "sonner";
import { ai, type ChatMode, type Conversation } from "@/lib/ai";
import {
  aiReadable,
  aiUploadName,
  mail,
  searchTerms,
  threadAsText,
  type MailThread,
} from "@/lib/mail";
import { useErrorToast } from "@/lib/useErrorToast";
import { Button } from "@/components/ui/button";
import { Composer } from "@/ai/Composer";
import { ContextBlock } from "@/ai/ContextBlock";
import { MessageList } from "@/ai/MessageList";
import { StreamingAnswer } from "@/ai/StreamingAnswer";
import { useChangedPages } from "@/ai/useChangedPages";
import { useChatStream } from "@/ai/useChatStream";
import { isConfigured, useAttachments } from "@/ai/useConversationSurface";
import { useProposals } from "@/review/useProposals";
import { splitThinking } from "@/chat/thinking";
import "@/models/ai.css";
import "@/ai/ai-page.css";

const UPLOAD_LIMIT = 25 * 1024 * 1024;
const TRY = [
  "Summarise this email",
  "What do I need to do, and by when?",
  "What is still open in this conversation?",
];
const TRY_FILES = "Summarise the attachments";
const TRY_REPLY = "Write a short reply to this email, in the language of the email";

/**
 * "Ask AI" beside an email. The conversation and the attachments the model can read (PDFs,
 * images, text) go along with the first question as files of this chat; the answer may also
 * use your pages.
 */
export function MailAskPanel({
  accountId,
  thread,
  onClose,
  onUseAsDraft,
  onSettings,
  onNavigate,
  settingsVersion,
}: {
  accountId: string;
  thread: MailThread;
  onClose: () => void;
  /** Start a reply with this text (an answer the user asked the model to write). */
  onUseAsDraft?: (text: string) => void;
  onSettings: () => void;
  onNavigate: (path: string) => void;
  settingsVersion: number;
}) {
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  // Ask answers; Act may also propose changes to pages, which wait for review as always.
  const [mode, setMode] = useState<ChatMode>("ask");
  const [preparing, setPreparing] = useState(true);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false);
  const [local, setLocal] = useState(true);
  const [modelVersion, setModelVersion] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const changedPages = useChangedPages();

  const ensureConversation = useCallback(async () => {
    const created = await ai.createConversation({ mode: "ask" });
    setSelected(created);
    return created;
  }, []);
  const chat = useChatStream({
    conversation: selected,
    ensureConversation,
    onConversationSaved: setSelected,
  });
  useErrorToast(chat.error, { label: "Open Settings", onClick: () => onSettings() });
  const files = useAttachments(selected, ensureConversation);
  const setAttachments = files.setAttachments;
  const reviews = useProposals(selected ? { conversation_id: selected.id } : null);

  // A chat of its own per email: the mail as text, and each attachment the model can read.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const conversation = await ai.createConversation({ mode: "ask" });
        const name = `Email - ${(thread.subject || "no subject")
          .replace(/[^\w .-]+/g, " ")
          .trim()
          .slice(0, 60)}.md`;
        const uploaded = [
          await ai.uploadAttachment(
            conversation.id,
            new Blob([threadAsText(thread)], { type: "text/markdown" }),
            name,
          ),
        ];
        const left: string[] = [];
        for (const message of thread.messages) {
          for (const [index, file] of message.attachments.entries()) {
            if (!aiReadable(file.name) || file.size > UPLOAD_LIMIT) {
              left.push(file.name);
              continue;
            }
            try {
              const blob = await mail.attachment(accountId, message.id, index);
              uploaded.push(
                await ai.uploadAttachment(conversation.id, blob, aiUploadName(file.name)),
              );
            } catch {
              left.push(file.name);
            }
          }
        }
        if (!live) return;
        setSelected(conversation);
        setAttachments(uploaded);
        setSkipped(left);
      } catch (e) {
        if (live) toast.error(`Could not prepare the email for AI: ${(e as Error).message}`);
      } finally {
        if (live) setPreparing(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [accountId, thread, setAttachments]);

  useEffect(() => {
    let live = true;
    void ai
      .status()
      .then((setup) => {
        if (!live) return;
        setConfigured(isConfigured(setup));
        setLocal(setup.config.provider === "local");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [settingsVersion, modelVersion]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [chat.stream, chat.messages, chat.status]);

  const send = async (text = draft) => {
    if (!configured) {
      onSettings();
      return;
    }
    setDraft("");
    // The pages are searched for the question and what the mail is about together.
    await chat.send(text, {
      mode,
      attachments: files.take(),
      searchQuery: `${text} ${searchTerms(thread)}`.slice(0, 590),
    });
  };

  const lastMessage = chat.messages[chat.messages.length - 1];
  const lastAnswer =
    lastMessage?.role === "assistant" ? splitThinking(lastMessage.content).answer.trim() : "";
  const hasFiles = thread.messages.some((m) => m.attachments.some((a) => aiReadable(a.name)));
  return (
    <aside className="ai-chat" aria-label="Ask AI about this email">
      <header className="ai-chat-header">
        <span>
          <Orbit size={17} /> Ask AI
        </span>
        <div>
          <Button
            variant="ghost"
            size="icon"
            title="Close"
            aria-label="Close Ask AI"
            onClick={onClose}
          >
            <X size={17} />
          </Button>
        </div>
      </header>
      <div className="ai-chat-body">
        {!chat.messages.length && (
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              {preparing
                ? "Getting the email and its attachments ready…"
                : "Ask about this email. The answer can also use your pages."}
            </p>
            {!preparing && (
              <p className="text-xs text-muted-foreground">
                To have a page changed from this email (a task added, a note updated), choose{" "}
                <button type="button" className="underline" onClick={() => setMode("act")}>
                  Act
                </button>{" "}
                in the menu below. The change is proposed for you to review.
              </p>
            )}
            {!preparing &&
              [...TRY, ...(hasFiles ? [TRY_FILES] : []), ...(onUseAsDraft ? [TRY_REPLY] : [])].map(
                (prompt) => (
                  <button
                    key={prompt}
                    className="rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                    disabled={chat.busy}
                    onClick={() => void send(prompt)}
                  >
                    {prompt}
                  </button>
                ),
              )}
            {skipped.length > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Paperclip className="mt-0.5 size-3 shrink-0" />
                Not readable by AI: {skipped.join(", ")}. It reads PDFs, pictures and text files.
              </p>
            )}
          </div>
        )}
        <ContextBlock context={chat.context} onNavigate={onNavigate} changed={changedPages} />
        <MessageList
          messages={chat.messages}
          onNavigate={onNavigate}
          changed={changedPages}
          proposals={reviews.byId}
          actions={reviews.actions}
        />
        {chat.busy && (
          <StreamingAnswer
            stream={chat.stream}
            thinking={chat.thinking}
            activity={chat.activity}
            status={chat.status}
            newSources={chat.newSources}
            onNavigate={onNavigate}
            proposals={chat.proposals}
            actions={reviews.actions}
          />
        )}
        {onUseAsDraft && !chat.busy && lastAnswer && (
          <Button variant="outline" size="sm" onClick={() => onUseAsDraft(lastAnswer)}>
            <PenLine /> Use as reply draft
          </Button>
        )}
        <div ref={end} />
      </div>
      <footer className="ai-chat-footer">
        <Composer
          compact
          contextId={selected?.id ?? "mail"}
          onSettings={onSettings}
          settingsVersion={settingsVersion}
          onModelChanged={() => setModelVersion((v) => v + 1)}
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          onStop={() => void chat.stop()}
          busy={chat.busy}
          disabled={preparing}
          mode={mode}
          onModeChange={setMode}
          attachments={files.attachments}
          onAttach={(list) => void files.attach(list)}
          onRemoveAttachment={(id) => void files.remove(id)}
          placeholder="Ask about this email…"
        />
        <p className="ai-chat-footnote">
          {local
            ? "Runs on this device: the email does not leave your computer."
            : "Your chat model is not on this device: asking sends this email to it."}
        </p>
      </footer>
    </aside>
  );
}
