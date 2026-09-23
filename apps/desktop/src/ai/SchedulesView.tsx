import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  CalendarClock,
  FileText,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { onDaemonEvent } from "@/lib/api";
import { automation, relative, type ScheduleInfo } from "@/lib/automation";
import { describeCron } from "@/lib/schedule";
import { ScheduleDialog, scheduleTarget } from "./ScheduleDialog";
import "./automation.css";

function sourceLabel(row: ScheduleInfo): string {
  if (row.source.startsWith("agent:")) return `Agent ${row.source.slice(6)}`;
  if (row.source.startsWith("live:")) return `Live note ${row.source.slice(5)}`;
  return row.source === "tool" ? "Scheduled in chat" : "Made here";
}

function SourceIcon({ source }: { source: string }) {
  if (source.startsWith("agent:")) return <Bot size={18} />;
  if (source.startsWith("live:")) return <FileText size={18} />;
  return source === "tool" ? <MessageSquare size={18} /> : <CalendarClock size={18} />;
}

const toastError = (e: Error) => toast.error(e.message);

function ScheduleCard({
  row,
  refresh,
  onEdit,
  onNavigate,
}: {
  row: ScheduleInfo;
  refresh: () => Promise<void>;
  onEdit: () => void;
  onNavigate?: (path: string) => void;
}) {
  // Rows mirrored from an agent or a live page are rewritten by the daemon's sync, so only
  // schedules made here or in chat can be edited or deleted.
  const own = !row.source.includes(":");
  const words = describeCron(row.expr);
  const failed = row.last_status?.startsWith("failed");
  const target = own ? scheduleTarget(row) : "";
  return (
    <article className="sched-card" aria-label={row.name} data-disabled={!row.enabled || undefined}>
      <span className="sched-card-icon">
        <SourceIcon source={row.source} />
      </span>
      <div className="sched-card-main">
        <div className="sched-card-title">
          <strong>{row.name}</strong>
          <span className="sched-badge">{sourceLabel(row)}</span>
        </div>
        <p>
          {words}
          {words !== row.expr && <code title="Cron expression (UTC)">{row.expr}</code>}
        </p>
        {target && <p className="sched-card-target">{target}</p>}
        <small>
          {row.enabled ? `Next ${relative(row.next_run_at)}` : "Paused"}
          {" · "}
          {row.last_run_at ? `last run ${relative(row.last_run_at)}` : "never ran"}
          {row.last_status && (
            <span
              className="auto-status"
              data-status={failed ? "failed" : row.last_status}
              title={row.last_status}
            >
              {failed ? "failed" : row.last_status}
            </span>
          )}
          {row.failures ? ` ${row.failures} failure${row.failures === 1 ? "" : "s"}` : ""}
        </small>
        {row.source.startsWith("agent:") && <small>Timing is set in the agent’s settings.</small>}
      </div>
      <div className="sched-card-actions">
        <button
          type="button"
          role="switch"
          className="sched-switch"
          aria-checked={row.enabled}
          aria-label={`${row.name} enabled`}
          title={row.enabled ? "Pause" : "Resume"}
          onClick={() =>
            void automation
              .patchSchedule(row.id, { enabled: !row.enabled })
              .then(refresh)
              .catch(toastError)
          }
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void automation
              .runSchedule(row.id)
              .then(() => toast.success(`${row.name} queued`))
              .catch(toastError)
          }
        >
          <Play size={13} /> Run now
        </Button>
        {row.source.startsWith("live:") && row.page_path && onNavigate && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Open ${row.name}`}
            onClick={() => onNavigate(row.page_path!)}
          >
            <FileText size={14} />
          </Button>
        )}
        {own && (
          <>
            <Button size="icon-sm" variant="ghost" aria-label={`Edit ${row.name}`} onClick={onEdit}>
              <Pencil size={14} />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${row.name}`}
              onClick={() => void automation.deleteSchedule(row.id).then(refresh).catch(toastError)}
            >
              <Trash2 size={14} />
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

/** Everything that runs on a timer: scheduled agents, live notes, and schedules made here or in chat. */
export function SchedulesView({ onNavigate }: { onNavigate?: (path: string) => void }) {
  const [rows, setRows] = useState<ScheduleInfo[]>([]);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ schedule: ScheduleInfo | null } | null>(null);
  const refresh = useCallback(async () => {
    try {
      setRows((await automation.schedules()).filter((row) => row.job_kind !== "workflow_run"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type === "schedule_update" || event.type === "job_update") void refresh();
      }),
    [refresh],
  );
  const active = rows.filter((row) => row.enabled);
  const paused = rows.filter((row) => !row.enabled);
  const list = (items: ScheduleInfo[]) =>
    items.map((row) => (
      <ScheduleCard
        key={row.id}
        row={row}
        refresh={refresh}
        onEdit={() => setDialog({ schedule: row })}
        onNavigate={onNavigate}
      />
    ));
  return (
    <section className="auto-view" aria-label="Schedules">
      <header className="auto-head">
        <h1>
          <CalendarClock size={20} /> Schedules
        </h1>
        <p>Scheduled agents, live pages, and follow-ups created in chat. All times are UTC.</p>
        <Button onClick={() => setDialog({ schedule: null })}>
          <Plus size={15} /> New schedule
        </Button>
      </header>
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      {!rows.length && !error && (
        <div className="sched-empty">
          <span className="sched-card-icon">
            <CalendarClock size={22} />
          </span>
          <h2>Nothing is scheduled</h2>
          <p>
            Run an agent every morning, or a set of instructions once a week. You can also ask the
            chat to schedule something.
          </p>
          <Button variant="outline" onClick={() => setDialog({ schedule: null })}>
            <Plus size={15} /> New schedule
          </Button>
        </div>
      )}
      {!!active.length && <div className="auto-list">{list(active)}</div>}
      {!!paused.length && (
        <>
          <h2 className="sched-group">Paused</h2>
          <div className="auto-list">{list(paused)}</div>
        </>
      )}
      <ScheduleDialog
        open={dialog !== null}
        schedule={dialog?.schedule ?? null}
        onClose={() => setDialog(null)}
        onSaved={() => void refresh()}
      />
    </section>
  );
}
