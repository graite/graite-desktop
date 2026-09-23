import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { automation, type AgentInfo, type ScheduleInfo } from "@/lib/automation";
import { isCronShape } from "@/lib/schedule";
import { ModelSelect } from "@/models/ModelSelect";
import { ScheduleBuilder } from "./ScheduleBuilder";

/** What a schedule made here or in chat runs: a saved agent, or its own instructions. */
export function scheduleTarget(row: ScheduleInfo): string {
  const agent = row.payload.agent as string | undefined;
  if (agent) return `Runs agent ${agent}`;
  const instructions = ((row.payload.instructions as string | undefined) ?? "").trim();
  return instructions
    ? `“${instructions.length > 90 ? `${instructions.slice(0, 90)}…` : instructions}”`
    : "";
}

/**
 * Create a schedule, or change the name and timing of one made here or in chat. What an
 * existing schedule runs is fixed: the daemon's PATCH carries no payload.
 */
export function ScheduleDialog({
  open,
  schedule,
  onClose,
  onSaved,
}: {
  open: boolean;
  schedule: ScheduleInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [expr, setExpr] = useState<string | null>("0 9 * * *");
  const [target, setTarget] = useState<"agent" | "instructions">("agent");
  const [agent, setAgent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(schedule?.name ?? "");
    setExpr(schedule?.expr ?? "0 9 * * *");
    setInstructions("");
    setError("");
    if (schedule) return;
    void automation
      .agents()
      .then((rows) => {
        setAgents(rows);
        setAgent((current) => current || rows[0]?.name || "");
        setTarget(rows.length ? "agent" : "instructions");
      })
      .catch(() => setTarget("instructions"));
  }, [open, schedule]);

  const ready =
    !!name.trim() &&
    !!expr &&
    isCronShape(expr) &&
    (!!schedule || (target === "agent" ? !!agent : !!instructions.trim()));
  const submit = async () => {
    if (!ready || !expr) return;
    setBusy(true);
    setError("");
    try {
      if (schedule) await automation.patchSchedule(schedule.id, { name: name.trim(), expr });
      else
        await automation.createSchedule({
          name: name.trim(),
          expr,
          job_kind: "agent_run",
          payload: target === "agent" ? { agent } : { instructions: instructions.trim() },
        });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sched-dialog">
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>
            {schedule
              ? "Change when this runs."
              : "Run an agent or a set of instructions at a recurring time."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="sched-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="sched-field">
            Name
            <input
              aria-label="Schedule name"
              placeholder="Weekly digest"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          {schedule ? (
            scheduleTarget(schedule) && <p className="sched-target">{scheduleTarget(schedule)}</p>
          ) : (
            <div className="sched-field">
              <span>What should run</span>
              <div className="ai-modes" role="tablist" aria-label="What should run">
                {(
                  [
                    ["agent", "An agent"],
                    ["instructions", "Instructions"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={target === id}
                    data-active={target === id || undefined}
                    disabled={id === "agent" && !agents.length}
                    onClick={() => setTarget(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {target === "agent" && !agents.length ? (
                <p className="sched-target">Loading agents…</p>
              ) : target === "agent" ? (
                <ModelSelect label="Agent" value={agent} onValueChange={setAgent}>
                  {agents.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </ModelSelect>
              ) : (
                <textarea
                  aria-label="Instructions"
                  placeholder="Summarise what changed in Projects this week and propose it as a new page."
                  rows={4}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              )}
            </div>
          )}
          <div className="sched-field">
            <span>When</span>
            <div className="sched-box">
              <ScheduleBuilder value={expr} onChange={setExpr} />
            </div>
          </div>
          {error && (
            <p className="review-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || busy}>
              {schedule ? "Save" : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
