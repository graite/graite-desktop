import { useEffect, useMemo, useRef, useState } from "react";
import { Orbit } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TextInstructionsEditor } from "@/editor/TextInstructionsEditor";
import { AgentSettings } from "@/ai/AgentSettings";
import type { TreeNode } from "@/lib/api";
import type { AgentBody } from "@/lib/automation";
import {
  assistant,
  bodyOf,
  SECTION_FIELDS,
  type AssistantBody,
  type AssistantInfo,
} from "@/lib/assistant";

/** Who the assistant is (four instruction sections) and how it works (the agent settings). */
export function AssistantProfile({
  info,
  tree,
  tab,
  onSaved,
}: {
  info: AssistantInfo;
  tree: TreeNode[];
  tab: "profile" | "settings";
  onSaved: (info: AssistantInfo) => void;
}) {
  const saved = useMemo(() => bodyOf(info), [info]);
  const [draft, setDraft] = useState<AssistantBody>(saved);
  const [busy, setBusy] = useState(false);
  const previous = useRef(saved);
  useEffect(() => {
    const before = previous.current;
    previous.current = saved;
    setDraft(
      (current) =>
        Object.fromEntries(
          Object.entries(saved).map(([key, value]) => [
            key,
            JSON.stringify(current[key as keyof AssistantBody]) ===
            JSON.stringify(before[key as keyof AssistantBody])
              ? value
              : current[key as keyof AssistantBody],
          ]),
        ) as AssistantBody,
    );
  }, [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const patch = (next: Partial<AssistantBody>) => setDraft((old) => ({ ...old, ...next }));
  const save = async () => {
    setBusy(true);
    try {
      const updated = await assistant.save(draft);
      setDraft(bodyOf(updated));
      onSaved(updated);
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // AgentSettings edits the fields an assistant shares with every agent.
  const asAgent: AgentBody = {
    name: draft.name,
    description: draft.description ?? "",
    instructions: "",
    scope: draft.scope,
    mode: draft.mode ?? "act",
    model: draft.model,
    skills: draft.skills,
    tools: draft.tools,
    schedule: draft.schedule,
    triggers: draft.triggers,
  };
  return (
    <div className="assistant-profile">
      <div className="agent-document-scroll" data-page-scroll>
        {tab === "profile" ? (
          <div className="agent-page-content">
            <div className="agent-document-title">
              <div className="agent-name-row">
                <span className="agent-avatar">
                  <Orbit size={25} />
                </span>
                <input
                  aria-label="Assistant name"
                  value={draft.name}
                  maxLength={80}
                  placeholder="Name your assistant"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              <input
                aria-label="Assistant description"
                value={draft.description ?? ""}
                maxLength={300}
                placeholder="Add a short description…"
                onChange={(e) => patch({ description: e.target.value })}
              />
            </div>
            <section className="assistant-section">
              <h2>What should I call you?</h2>
              <p>It greets you by this name when you start talking. Leave empty for “Hi there.”</p>
              <input
                className="assistant-name-input"
                aria-label="Your name"
                value={draft.user_name ?? ""}
                maxLength={60}
                placeholder="Your first name"
                onChange={(e) => patch({ user_name: e.target.value })}
              />
            </section>
            {SECTION_FIELDS.map((field) => (
              <section className="assistant-section" key={field.key}>
                <h2>{field.label}</h2>
                <p>{field.hint}</p>
                <TextInstructionsEditor
                  label={field.label}
                  value={draft.sections?.[field.key] ?? ""}
                  onChange={(value) =>
                    patch({ sections: { ...draft.sections, [field.key]: value } })
                  }
                />
              </section>
            ))}
          </div>
        ) : (
          <AgentSettings
            draft={asAgent}
            tree={tree}
            onChange={(next) => {
              const { scope, mode, model, skills, tools, schedule, triggers } = {
                ...asAgent,
                ...next,
              };
              patch({ scope, mode, model, skills, tools, schedule, triggers });
            }}
          />
        )}
      </div>
      {dirty && (
        <div className="assistant-savebar">
          <span>Unsaved changes</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button size="sm" disabled={busy || !draft.name.trim()} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
