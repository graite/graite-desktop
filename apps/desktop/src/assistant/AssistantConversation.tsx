import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Orbit, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { ai, type Conversation } from "@/lib/ai";
import { assistant, type AssistantInfo } from "@/lib/assistant";
import { Button } from "@/components/ui/button";
import { Composer } from "@/ai/Composer";
import { ContextBlock } from "@/ai/ContextBlock";
import { MessageList } from "@/ai/MessageList";
import { LimitsCallout } from "@/ai/Sources";
import { StreamingAnswer } from "@/ai/StreamingAnswer";
import { useChangedPages } from "@/ai/useChangedPages";
import { useChatStream } from "@/ai/useChatStream";
import { isConfigured, useAttachments } from "@/ai/useConversationSurface";
import { useProposals } from "@/review/useProposals";
import { useVoiceSession } from "./useVoiceSession";
import { VoiceBar } from "./VoiceBar";

/** Typed conversation with the assistant: the ordinary chat surface, in its own sessions. */
export function AssistantConversation({
  info,
  seed,
  visible,
  onNavigate,
  onSettings,
  settingsVersion,
}: {
  info: AssistantInfo;
  /** Text to put in the message box (answering a question from the background loop). */
  seed?: { text: string; n: number } | null;
  visible: boolean;
  onNavigate: (path: string) => void;
  onSettings: (tab?: "voice") => void;
  settingsVersion: number;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [configured, setConfigured] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const changedPages = useChangedPages();

  const open = useCallback(async (fresh = false) => {
    const ref = await assistant.conversation(fresh);
    const loaded = await ai.conversation(ref.id);
    setConversation(loaded);
    return loaded;
  }, []);
  const ensureConversation = useCallback(() => open(false), [open]);
  const chat = useChatStream({
    conversation,
    ensureConversation,
    onConversationSaved: setConversation,
  });
  const files = useAttachments(conversation, ensureConversation);
  const reviews = useProposals(conversation ? { conversation_id: conversation.id } : null);

  useEffect(() => {
    void open(false).catch((e: Error) => toast.error(e.message));
  }, [open, info.path]);
  useEffect(() => {
    void ai
      .status()
      .then((status) => setConfigured(isConfigured(status)))
      .catch(() => undefined);
  }, [settingsVersion]);
  useEffect(() => {
    if (seed) setDraft(seed.text);
  }, [seed]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [chat.stream, chat.messages, chat.status]);

  const conversationId = conversation?.id;
  const reload = useCallback(() => {
    if (conversationId)
      void ai
        .conversation(conversationId)
        .then(setConversation)
        .catch(() => undefined);
  }, [conversationId]);
  const voice = useVoiceSession({ onTurnSaved: reload });
  const talk = async () => {
    if (!configured) return onSettings();
    try {
      const target = conversation ?? (await open(false));
      await voice.start(target.id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const send = async () => {
    if (!configured) return onSettings();
    const text = draft;
    setDraft("");
    await chat.send(text, { attachments: files.take() });
  };
  const empty = !chat.messages.length && !chat.busy;
  return (
    <div className="assistant-conversation">
      <div className="ai-page-body">
        <div className="ai-page-thread">
          {empty && (
            <div className="ai-chat-empty assistant-welcome">
              <div className="assistant-welcome-icon" aria-hidden="true">
                <Orbit size={30} />
              </div>
              <span className="assistant-eyebrow">YOUR PERSONAL ASSISTANT</span>
              <h2>Hi, I’m {info.name}.</h2>
              <p>Talk or type. I know your pages and I remember what you tell me.</p>
              {!configured && (
                <Button className="mb-4" onClick={() => onSettings()}>
                  <Settings2 size={15} /> Choose your model
                </Button>
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
          {chat.clarify && <div className="ai-notice">{chat.clarify}</div>}
          {!chat.busy && chat.limits && (
            <LimitsCallout items={chat.limits.items} excluded={chat.limits.excluded_local_only} />
          )}
          {chat.error && (
            <div className="ai-notice ai-error" role="alert">
              {chat.error}
              <button onClick={() => onSettings()}>Open Settings</button>
            </div>
          )}
          <div ref={end} />
        </div>
      </div>
      <footer className="ai-page-footer">
        <VoiceBar
          name={info.name}
          session={voice}
          disabled={chat.busy}
          onStart={() => void talk()}
          onSettings={onSettings}
          settingsVersion={settingsVersion}
        />
        {visible && (
          <Composer
            contextId={conversation?.id ?? "assistant"}
            placeholder={`Message ${info.name}…`}
            onSettings={() => onSettings()}
            settingsVersion={settingsVersion}
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            onStop={() => void chat.stop()}
            busy={chat.busy}
            disabled={voice.active}
            mode={(info.mode as "ask" | "act") ?? "act"}
            onModeChange={() => undefined}
            fixedMode
            attachments={files.attachments}
            onAttach={(list) => void files.attach(list)}
            onRemoveAttachment={(id) => void files.remove(id)}
            left={
              <Button
                variant="ghost"
                size="sm"
                className="ml-1"
                disabled={chat.busy || empty}
                title="Start a new session; memory carries over"
                onClick={() => void open(true).then(() => chat.setMessages([]))}
              >
                <MessageSquarePlus size={14} /> New session
              </Button>
            }
          />
        )}
      </footer>
    </div>
  );
}
