import { useCallback, useEffect, useState } from "react";
import { Activity, AlertCircle, ArrowLeft, HelpCircle, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MarkdownAnswer } from "@/chat/MarkdownAnswer";
import { ai, type JobInfo } from "@/lib/ai";
import { onDaemonEvent } from "@/lib/api";
import {
  automation,
  relative,
  RUN_KIND_LABELS,
  RUN_STATUS_LABELS,
  stepSummary,
  type RunDetail,
  type RunInfo,
  type RunStep,
} from "@/lib/automation";
import type { Proposal } from "@/lib/review";
import { ProposalCard } from "@/review/ProposalCard";
import { useProposals } from "@/review/useProposals";
import "./automation.css";

type KindFilter = "agent_run" | "chat_turn" | "live_note" | "all";
const KIND_FILTERS: [KindFilter, string][] = [
  ["agent_run", "Agents"],
  ["live_note", "Live notes"],
  ["chat_turn", "Chats"],
  ["all", "All"],
];

function statusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

function RunRow({ run, onOpen }: { run: RunInfo; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className="auto-row"
      data-status={run.status}
      onClick={() => onOpen(run.id)}
    >
      <span className="auto-row-kind">{RUN_KIND_LABELS[run.kind] ?? run.kind}</span>
      <span className="auto-row-name">
        {run.agent ??
          run.workflow ??
          (run.input?.question as string | undefined) ??
          run.page_path ??
          "—"}
      </span>
      <span className="auto-row-status">{statusLabel(run.status)}</span>
      <span className="auto-row-time">{relative(run.started_at)}</span>
    </button>
  );
}

function duration(run: RunInfo): string {
  const seconds = (run.output?.seconds as number | undefined) ?? null;
  if (typeof seconds === "number")
    return seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`;
  return "";
}

/** Steps in the order they happened to the reader: tool calls before the model round that closes them. */
function orderSteps(steps: RunStep[]): RunStep[] {
  const closing = steps.filter((s) => s.kind === "generate" || s.kind === "research");
  return [...steps.filter((s) => !closing.includes(s)), ...closing];
}

function Step({ step, onNavigate }: { step: RunStep; onNavigate: (path: string) => void }) {
  const { title, detail, page } = stepSummary(step);
  const isTool = step.kind === "tool";
  const proposal = step.output?.proposal_id as string | undefined;
  return (
    <li
      data-status={step.status}
      data-kind={step.kind}
      data-group={
        isTool && step.name?.startsWith("propose_") ? "propose" : isTool ? "read" : "system"
      }
    >
      <span className="auto-step-title">
        {step.status === "running" ? <Loader2 size={12} className="animate-spin" /> : null}
        {page && isTool ? (
          <>
            {title.replace(page, "").trim()}{" "}
            <button type="button" className="auto-step-page" onClick={() => onNavigate(page)}>
              {page}
            </button>
          </>
        ) : (
          title
        )}
      </span>
      {detail ? <span className="auto-step-detail">{detail}</span> : null}
      {proposal ? <span className="auto-step-badge">proposal</span> : null}
      <small>{statusLabel(step.status)}</small>
    </li>
  );
}

function Detail({
  id,
  onBack,
  onNavigate,
  onOpen,
}: {
  id: string;
  onBack: () => void;
  onNavigate: (path: string) => void;
  onOpen: (id: string) => void;
}) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const { actions } = useProposals(null);
  const load = useCallback(() => {
    automation
      .run(id)
      .then(setRun)
      .catch((e: Error) => toast.error(e.message));
  }, [id]);
  useEffect(() => {
    setRun(null);
    load();
  }, [load]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type === "run_update" && (event.data as { id?: string }).id === id) load();
        if (event.type === "proposal_decided" && (event.data as { run_id?: string }).run_id === id)
          load();
      }),
    [id, load],
  );
  if (!run) return <p className="review-empty">Loading…</p>;
  const steps = orderSteps((run.steps ?? []) as unknown as RunStep[]);
  const children = run.children ?? [];
  const proposals = (run.proposals ?? []) as unknown as Proposal[];
  const answer = (run.output?.answer as string | undefined) ?? "";
  const question = (run.output?.question as string | undefined) ?? "";
  const notes = (run.input?.notes as string[] | undefined) ?? [];
  const trigger = (run.input?.question as string | undefined) ?? "";
  const tokens = run.output?.tokens as { prompt?: number; completion?: number } | undefined;
  return (
    <div className="auto-detail">
      <Button variant="ghost" size="sm" className="-ml-2.5 self-start" onClick={onBack}>
        <ArrowLeft size={13} /> All runs
      </Button>
      <h2>
        {RUN_KIND_LABELS[run.kind] ?? run.kind} ·{" "}
        {run.agent ?? run.workflow ?? run.page_path ?? run.id.slice(0, 8)}
        <span className="auto-status" data-status={run.status}>
          {run.status === "running" ? <Loader2 size={12} className="animate-spin" /> : null}
          {statusLabel(run.status)}
        </span>
      </h2>
      <p className="auto-meta">
        {run.kind !== "chat_turn" && trigger ? `${trigger} · ` : ""}
        started {relative(run.started_at)}
        {duration(run) ? ` · ${duration(run)}` : ""}
        {run.model ? ` · ${run.model.split("/").pop()}` : run.provider ? ` · ${run.provider}` : ""}
        {tokens?.prompt || tokens?.completion
          ? ` · ${(tokens.prompt ?? 0) + (tokens.completion ?? 0)} tokens`
          : ""}
      </p>
      {notes.map((note) => (
        <p className="auto-note" key={note}>
          <AlertCircle size={13} /> {note}
        </p>
      ))}
      {run.error ? (
        <p className="review-error auto-error" role="alert">
          <XCircle size={13} /> {run.error}
        </p>
      ) : null}
      {!!steps.length && (
        <section className="auto-section">
          <h3>What happened</h3>
          <ol className="auto-timeline" aria-label="Steps">
            {steps.map((step) => (
              <Step key={String(step.ord)} step={step} onNavigate={onNavigate} />
            ))}
          </ol>
        </section>
      )}
      {!!children.length && (
        <div className="auto-children" aria-label="Child runs">
          {children.map((child) => (
            <RunRow key={child.id} run={child} onOpen={onOpen} />
          ))}
        </div>
      )}
      {question ? (
        <section className="auto-section auto-needs-input" role="status">
          <h3>
            <HelpCircle size={14} /> The agent needs input
          </h3>
          <p>{question}</p>
          <small>Answer it in the agent's instructions, then run the agent again.</small>
        </section>
      ) : null}
      {!!proposals.length && (
        <section className="auto-section">
          <h3>Proposals ({proposals.length})</h3>
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} actions={actions} onNavigate={onNavigate} />
          ))}
        </section>
      )}
      {answer ? (
        <section className="auto-section">
          <h3>Report</h3>
          <div className="auto-answer">
            <MarkdownAnswer content={answer} onNavigate={onNavigate} />
          </div>
        </section>
      ) : run.status !== "running" &&
        !proposals.length &&
        !run.error &&
        run.kind !== "chat_turn" ? (
        <p className="review-empty">This run left no report.</p>
      ) : null}
    </div>
  );
}

/** Everything the daemon ran: agents, live notes and chats, plus the job queue. */
export function RunsView({
  onNavigate,
  openRunId,
  onOpenRun,
}: {
  onNavigate: (path: string) => void;
  openRunId: string | null;
  onOpenRun: (id: string | null) => void;
}) {
  const [tab, setTab] = useState<"runs" | "jobs">("runs");
  const [kind, setKind] = useState<KindFilter>("agent_run");
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [r, j] = await Promise.all([
        automation.runs({ kind: kind === "all" ? undefined : kind, limit: 100 }),
        ai.jobs(),
      ]);
      setRuns(r);
      setJobs(j);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [kind]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type === "job_update" || event.type === "run_update" || event.type === "proposal")
          void refresh();
      }),
    [refresh],
  );
  return (
    <section className="auto-view" aria-label="Runs">
      {openRunId ? (
        <Detail
          id={openRunId}
          onBack={() => onOpenRun(null)}
          onNavigate={onNavigate}
          onOpen={onOpenRun}
        />
      ) : (
        <>
          <header className="auto-head">
            <h1>
              <Activity size={20} /> Runs
            </h1>
            <div className="ai-modes" role="tablist" aria-label="Runs or jobs">
              {(["runs", "jobs"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  data-active={tab === id || undefined}
                  onClick={() => setTab(id)}
                >
                  {id === "runs"
                    ? `Runs (${runs.length})`
                    : `Jobs (${jobs.filter((j) => j.status === "pending" || j.status === "running").length} open)`}
                </button>
              ))}
            </div>
          </header>
          {error && (
            <p className="review-error" role="alert">
              {error}
            </p>
          )}
          {tab === "runs" && (
            <>
              <div className="auto-filters" role="group" aria-label="Run kind">
                {KIND_FILTERS.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={kind === id}
                    data-active={kind === id || undefined}
                    onClick={() => setKind(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="auto-rows">
                {!runs.length && (
                  <p className="review-empty">
                    {kind === "agent_run"
                      ? "No agent has run yet. Open an agent and choose Run agent."
                      : "Nothing has run yet."}
                  </p>
                )}
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} onOpen={onOpenRun} />
                ))}
              </div>
            </>
          )}
          {tab === "jobs" && (
            <div className="auto-rows">
              {!jobs.length && <p className="review-empty">The job queue is empty.</p>}
              {jobs.map((job) => (
                <div key={job.id} className="auto-row" data-status={job.status}>
                  <span className="auto-row-kind">{job.kind}</span>
                  <span className="auto-row-name">
                    {(job.progress?.message as string | undefined) ??
                      job.page_path ??
                      job.id.slice(0, 8)}
                    {job.error ? ` · ${job.error}` : ""}
                  </span>
                  <span className="auto-row-status">{job.status}</span>
                  <span className="auto-row-time">{relative(job.created_at)}</span>
                  {job.run_id ? (
                    <button
                      type="button"
                      className="auto-row-open"
                      onClick={() => onOpenRun(job.run_id as string)}
                    >
                      Open run
                    </button>
                  ) : job.status === "pending" || job.status === "running" ? (
                    <button
                      type="button"
                      className="auto-row-cancel"
                      aria-label={`Cancel job ${job.id.slice(0, 8)}`}
                      onClick={() =>
                        void ai
                          .cancelJob(job.id)
                          .then(refresh)
                          .catch((e: Error) => toast.error(e.message))
                      }
                    >
                      <XCircle size={14} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
