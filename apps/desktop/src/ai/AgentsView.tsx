import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  Bot,
  CalendarClock,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TreeNode } from "@/lib/api";
import { onDaemonEvent } from "@/lib/api";
import { automation, relative, type AgentBody, type AgentInfo } from "@/lib/automation";
import { describeCron } from "@/lib/schedule";
import { AgentWorkspace } from "./AgentWorkspace";
import { AGENT_TEMPLATES, agentBody, blankAgent } from "./agent-templates";
import "./automation.css";
import "./agent-workspace.css";

export function AgentsView({
  tree,
  onOpenRun,
  onNavigate = () => {},
}: {
  tree: TreeNode[];
  onOpenRun: (runId: string) => void;
  onNavigate?: (path: string) => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState<{
    agent: AgentInfo | null;
    initial: AgentBody;
    prompt?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      // The personal assistant has its own place in the rail; it is not listed with the agents.
      setAgents((await automation.agents()).filter((a) => !a.assistant));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type === "policy_changed" || event.type === "job_update") void refresh();
      }),
    [refresh],
  );
  const create = (initial: AgentBody, text?: string) => {
    setCreating(false);
    setPrompt("");
    setWorkspace({ initial, agent: null, prompt: text });
  };
  if (workspace)
    return (
      <AgentWorkspace
        initial={workspace.initial}
        agent={workspace.agent}
        initialPrompt={workspace.prompt}
        tree={tree}
        onClose={() => setWorkspace(null)}
        onSaved={() => void refresh()}
        onNavigate={onNavigate}
        onOpenRun={onOpenRun}
      />
    );
  return (
    <section className="auto-view agents-home" aria-label="Agents">
      <header className="agents-home-header">
        <div>
          <span className="agent-eyebrow">YOUR WORKSPACE, WORKING WITH YOU</span>
          <h1>Agents</h1>
          <p>A little help, built around the way you work.</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={15} /> New agent
        </Button>
      </header>
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="review-empty">Loading agents…</p>
      ) : (
        !agents.length && (
          <div className="agents-empty">
            <div className="agent-avatar">
              <Bot size={30} />
            </div>
            <h2>Give your work a helping hand</h2>
            <p>
              Create an agent that knows your pages, follows your instructions, and runs when you
              need it.
            </p>
            <Button variant="outline" onClick={() => setCreating(true)}>
              Create your first agent <ArrowRight size={15} />
            </Button>
          </div>
        )
      )}
      {!!agents.length && (
        <div className="agents-grid">
          {agents.map((agent) => (
            <article key={agent.name} className="agent-home-card" aria-label={agent.name}>
              <div className="agent-card-top">
                <span className="agent-avatar">
                  <Bot size={22} />
                </span>
                <div className="agent-card-actions">
                  <button
                    aria-label={`Edit ${agent.name}`}
                    onClick={() => setWorkspace({ agent, initial: agentBody(agent) })}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    aria-label={`Delete ${agent.name}`}
                    onClick={() => setDeleting(agent.name)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <button
                className="agent-card-title"
                onClick={() => setWorkspace({ agent, initial: agentBody(agent) })}
              >
                {agent.name}
                <ArrowRight size={16} />
              </button>
              <p>{agent.description || "Add instructions and make this agent your own."}</p>
              <div className="agent-card-badges">
                <span>
                  <Play size={11} /> On demand
                </span>
                {agent.schedule && (
                  <span title={agent.schedule}>
                    <CalendarClock size={12} /> Scheduled
                  </span>
                )}
                {!!agent.triggers?.filter((t) => t.enabled).length && (
                  <span>
                    <Zap size={12} /> Page triggers
                  </span>
                )}
              </div>
              <small>
                {agent.scope.kind === "vault" ? "All pages" : (agent.scope.roots ?? []).join(", ")}{" "}
                · {agent.mode === "ask" ? "answers only" : "proposes changes"}
                {agent.schedule ? ` · ${describeCron(agent.schedule)}` : ""}
              </small>
              <footer>
                {agent.last_run ? (
                  <button
                    className="agent-last-run"
                    onClick={() => onOpenRun(String(agent.last_run?.id))}
                  >
                    {String(agent.last_run.status)} · {relative(String(agent.last_run.started_at))}
                  </button>
                ) : (
                  <small>No runs yet</small>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void automation
                      .runAgent(agent.name)
                      .then(() => toast.success(`${agent.name} queued`))
                      .catch((e: Error) => toast.error(e.message))
                  }
                >
                  <Play size={12} /> Run now
                </Button>
              </footer>
            </article>
          ))}
        </div>
      )}
      <div className="agents-template-heading">
        <Sparkles size={16} />
        <h2>Start with a little inspiration</h2>
      </div>
      <div className="agent-templates">
        {AGENT_TEMPLATES.map((template) => (
          <button
            key={template.name}
            onClick={() =>
              create({
                ...blankAgent(),
                name: template.name,
                description: template.description,
                instructions: template.instructions,
                mode: template.name === "Knowledge assistant" ? "ask" : "act",
              })
            }
          >
            <span>{template.icon}</span>
            <strong>{template.name}</strong>
            <p>{template.description}</p>
            <small>
              Use template <ArrowRight size={12} />
            </small>
          </button>
        ))}
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="agent-create-dialog">
          <DialogHeader>
            <DialogTitle className="sr-only">Create an agent</DialogTitle>
          </DialogHeader>
          <button className="agent-create-blank" onClick={() => create(blankAgent())}>
            <Pencil size={13} /> Create blank
          </button>
          <div className="agent-create-intro">
            <span className="agent-avatar">
              <Sparkles size={32} />
            </span>
            <h2>What should your agent do?</h2>
            <p>Describe a job. We’ll work out the details together.</p>
          </div>
          <form
            className="agent-create-prompt"
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim()) create(blankAgent(), prompt.trim());
            }}
          >
            <textarea
              aria-label="Describe your agent"
              autoFocus
              value={prompt}
              maxLength={12000}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Help me turn meeting notes into action items…"
              rows={4}
            />
            <button type="submit" disabled={!prompt.trim()} aria-label="Create with AI">
              <ArrowUp size={19} />
            </button>
          </form>
          <div className="agents-template-heading">
            <Sparkles size={14} /> Or start with a template
          </div>
          <div className="agent-templates">
            {AGENT_TEMPLATES.map((template) => (
              <button
                key={template.name}
                onClick={() =>
                  create({
                    ...blankAgent(),
                    name: template.name,
                    description: template.description,
                    instructions: template.instructions,
                    mode: template.name === "Knowledge assistant" ? "ask" : "act",
                  })
                }
              >
                <span>{template.icon}</span>
                <strong>{template.name}</strong>
                <p>{template.description}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting}?</DialogTitle>
          </DialogHeader>
          <p>This removes the agent definition and its schedule. Knowledge pages are kept.</p>
          <div className="ai-setting-actions">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deleting) return;
                try {
                  await automation.deleteAgent(deleting);
                  setDeleting(null);
                  await refresh();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Delete agent
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
