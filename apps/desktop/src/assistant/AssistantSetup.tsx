import { useState } from "react";
import { Orbit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { assistant, type AssistantInfo } from "@/lib/assistant";

/** First run: give the assistant a name. Everything else can be filled in later. */
export function AssistantSetup({ onCreated }: { onCreated: (info: AssistantInfo) => void }) {
  const [name, setName] = useState("");
  const [goals, setGoals] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      let info = await assistant.save({ name: name.trim(), sections: { goals: goals.trim() } });
      if (remember) {
        await assistant.optInMemory();
        info = await assistant.get();
      }
      onCreated(info);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="assistant-setup"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="ai-orb">
        <Orbit size={27} />
      </div>
      <h1>Meet your personal assistant</h1>
      <p>
        It talks with you, looks things up in your pages, remembers what matters to you and keeps
        working on your goals in the background. Changes to your pages still follow each page’s AI
        settings.
      </p>
      <label>
        <span>Name</span>
        <input
          autoFocus
          aria-label="Assistant name"
          value={name}
          maxLength={80}
          placeholder="Ada"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        <span>
          What should it help you with? <small>Optional</small>
        </span>
        <textarea
          aria-label="Goals"
          value={goals}
          rows={3}
          maxLength={8000}
          placeholder="- Keep my week planned&#10;- Help me finish the Atlas project"
          onChange={(e) => setGoals(e.target.value)}
        />
      </label>
      <label className="assistant-check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>
          Let it update its own memory pages without asking.
          <small>
            A page named after it holds what it remembers about you. You can read, edit and revert
            everything there.
          </small>
        </span>
      </label>
      {error && (
        <div className="ai-notice ai-error" role="alert">
          {error}
        </div>
      )}
      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? "Setting up…" : "Create assistant"}
      </Button>
    </form>
  );
}
