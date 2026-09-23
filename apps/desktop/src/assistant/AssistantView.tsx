import { useEffect, useState } from "react";
import { AudioLines, BookUser, Brain, MessageSquare, Orbit, Repeat, Settings2 } from "lucide-react";
import type { TreeNode } from "@/lib/api";
import { toast } from "sonner";
import { assistant, bodyOf } from "@/lib/assistant";
import { Button } from "@/components/ui/button";
import { AssistantBackground } from "./AssistantBackground";
import { AssistantConversation } from "./AssistantConversation";
import { AssistantMemory } from "./AssistantMemory";
import { AssistantProfile } from "./AssistantProfile";
import { AssistantSetup } from "./AssistantSetup";
import { AssistantVoice } from "./AssistantVoice";
import type { useAssistant } from "./useAssistant";
import "@/ai/agent-workspace.css";
import "./assistant.css";

type Tab = "conversation" | "profile" | "memory" | "voice" | "background" | "settings";
const TABS: { id: Tab; label: string; icon: typeof Orbit }[] = [
  { id: "conversation", label: "Conversation", icon: MessageSquare },
  { id: "profile", label: "Profile", icon: BookUser },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "voice", label: "Voice", icon: AudioLines },
  { id: "background", label: "Background", icon: Repeat },
  { id: "settings", label: "Settings", icon: Settings2 },
];

/** The personal assistant's page in the Studio, titled with the name the user gave it. */
export function AssistantView({
  state,
  tree,
  visible,
  onNavigate,
  onSettings,
  settingsVersion,
  onOpenRun,
  requestedPage,
}: {
  requestedPage?: { path: string; n: number } | null;
  state: ReturnType<typeof useAssistant>;
  tree: TreeNode[];
  visible: boolean;
  onNavigate: (path: string) => void;
  onSettings: (tab?: "voice") => void;
  settingsVersion: number;
  onOpenRun: (id: string) => void;
}) {
  const { info, setInfo, error, refresh } = state;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [tab, setTab] = useState<Tab>("conversation");
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    if (requestedPage) setTab("memory");
  }, [requestedPage]);
  const questions = info?.questions?.length ?? 0;
  if (!info) {
    return (
      <section className="assistant-view">
        {error ? (
          <div className="ai-notice ai-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="assistant-muted">Loading…</p>
        )}
      </section>
    );
  }
  if (!info.configured) {
    return (
      <section className="assistant-view">
        <AssistantSetup onCreated={setInfo} />
      </section>
    );
  }
  return (
    <section className="assistant-view" aria-label={info.name}>
      <header className="ai-page-header">
        <nav className="ai-page-title" aria-label="Studio breadcrumb">
          <Orbit size={18} />
          <span>Studio</span>
          <span className="text-muted-foreground">/</span>
          {renaming ? (
            <form
              className="assistant-rename"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!name.trim() || savingName) return;
                setSavingName(true);
                try {
                  setInfo(await assistant.save({ ...bodyOf(info), name: name.trim() }));
                  setRenaming(false);
                } catch (error) {
                  toast.error((error as Error).message);
                } finally {
                  setSavingName(false);
                }
              }}
            >
              <input
                autoFocus
                aria-label="New assistant name"
                value={name}
                maxLength={80}
                disabled={savingName}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && !savingName) setRenaming(false);
                }}
              />
              <Button size="sm" type="submit" disabled={!name.trim() || savingName}>
                Save name
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={savingName}
                onClick={() => setRenaming(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <button
              className="ai-chat-title assistant-rename-trigger"
              title="Rename assistant"
              aria-label={`Rename ${info.name}`}
              onClick={() => {
                setName(info.name);
                setRenaming(true);
              }}
            >
              {info.name}
              <span>Rename</span>
            </button>
          )}
        </nav>
      </header>
      <nav className="assistant-tabs" aria-label={`${info.name} sections`}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            <Icon size={15} /> {label}
            {id === "background" && questions > 0 && (
              <span className="ai-rail-count">{questions}</span>
            )}
          </button>
        ))}
      </nav>
      {/* The conversation stays mounted so a running answer or a voice session survives a tab switch. */}
      <div className="assistant-tab" hidden={tab !== "conversation"}>
        <AssistantConversation
          info={info}
          seed={seed}
          visible={visible && tab === "conversation"}
          onNavigate={onNavigate}
          onSettings={onSettings}
          settingsVersion={settingsVersion}
        />
      </div>
      <div className="assistant-tab" hidden={tab !== "profile" && tab !== "settings"}>
        <AssistantProfile
          info={info}
          tree={tree}
          tab={tab === "settings" ? "settings" : "profile"}
          onSaved={setInfo}
        />
      </div>
      {tab === "background" && (
        <AssistantBackground
          info={info}
          onChanged={() => void refresh()}
          onOpenRun={onOpenRun}
          onEditSchedule={() => setTab("settings")}
          onAnswer={(question) => {
            setSeed((old) => ({
              text: `About your question “${question}”: `,
              n: (old?.n ?? 0) + 1,
            }));
            setTab("conversation");
          }}
        />
      )}
      {tab === "voice" && <AssistantVoice info={info} onSaved={setInfo} onSettings={onSettings} />}
      <div className="assistant-tab" hidden={tab !== "memory"}>
        <AssistantMemory
          requestedPage={requestedPage}
          info={info}
          tree={tree}
          onNavigate={onNavigate}
          onChanged={() => void refresh()}
        />
      </div>
    </section>
  );
}
