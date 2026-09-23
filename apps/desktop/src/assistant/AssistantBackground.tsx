import { useCallback, useEffect, useState } from "react";
import { CircleHelp, Pause, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { onDaemonEvent } from "@/lib/api";
import { assistant, type AssistantInfo } from "@/lib/assistant";
import { automation, relative, type RunInfo } from "@/lib/automation";

const OUTCOME: Record<string, string> = {
  succeeded: "Done",
  needs_input: "Has a question",
  failed: "Failed",
  cancelled: "Made way for you",
  running: "Working…",
};

/** The loop: when the assistant works on the goals by itself, what it did, what it asks. */
export function AssistantBackground({
  info,
  onChanged,
  onAnswer,
  onOpenRun,
  onEditSchedule,
}: {
  info: AssistantInfo;
  onChanged: () => void;
  /** Take a question into the conversation. */
  onAnswer: (question: string) => void;
  onOpenRun: (id: string) => void;
  onEditSchedule: () => void;
}) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const loop = info.loop;
  const load = useCallback(() => {
    void automation
      .runs({ kind: "assistant_loop", limit: 15 })
      .then(setRuns)
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type !== "run_update") return;
        const data = event.data as { kind?: string; step?: unknown };
        if (data.kind === "assistant_loop" && !data.step) {
          load();
          onChanged();
        }
      }),
    [load, onChanged],
  );
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done) toast.success(done);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="assistant-pane" data-page-scroll>
      <h2>Background</h2>
      <p>
        On a schedule, {info.name} looks at your goals and at what changed in your pages, proposes
        what would help, and logs it in the Journal. It steps aside whenever you start talking to
        it.
      </p>
      <div className="assistant-loop-card">
        {loop ? (
          <>
            <div>
              <strong>{loop.enabled ? "Running on schedule" : "Paused"}</strong>
              <small>
                {loop.enabled && loop.next_run_at
                  ? `Next pass ${relative(loop.next_run_at)}. `
                  : ""}
                {loop.last_run_at
                  ? `Last pass ${relative(loop.last_run_at)}${loop.last_status ? ` (${loop.last_status})` : ""}.`
                  : "No pass yet."}
              </small>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  automation.patchSchedule(loop.schedule_id, { enabled: !loop.enabled }),
                )
              }
            >
              {loop.enabled ? (
                <>
                  <Pause size={14} /> Pause
                </>
              ) : (
                <>
                  <Play size={14} /> Resume
                </>
              )}
            </Button>
          </>
        ) : (
          <div>
            <strong>No schedule</strong>
            <small>
              {info.name} only works when you talk to it. Pick a schedule to let it work by itself.
            </small>
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={onEditSchedule}>
          {loop ? "Change schedule" : "Choose a schedule"}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void act(() => assistant.runLoop(), "Started a background pass")}
        >
          <RefreshCw size={14} /> Run now
        </Button>
      </div>

      <h3>Questions for you</h3>
      {!info.questions?.length && <p className="assistant-muted">Nothing is waiting for you.</p>}
      {info.questions?.map((q) => (
        <div className="assistant-question" key={q.run_id}>
          <CircleHelp size={16} />
          <span>
            {q.question}
            <small>{relative(q.asked_at)}</small>
          </span>
          <Button
            size="sm"
            onClick={() => {
              onAnswer(q.question);
              void assistant.dismissQuestion(q.run_id).then(onChanged);
            }}
          >
            Answer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void act(() => assistant.dismissQuestion(q.run_id))}
          >
            Dismiss
          </Button>
        </div>
      ))}

      <h3>Recent passes</h3>
      {!runs.length && <p className="assistant-muted">No background pass has run yet.</p>}
      <div className="assistant-runs">
        {runs.map((run) => (
          <button key={run.id} onClick={() => onOpenRun(run.id)}>
            <span data-status={run.status}>{OUTCOME[run.status] ?? run.status}</span>
            <small>{relative(run.started_at)}</small>
            <em>
              {String((run.output as { answer?: string } | null)?.answer ?? run.error ?? "")
                .split("\n")[0]
                .slice(0, 140)}
            </em>
          </button>
        ))}
      </div>
    </div>
  );
}
