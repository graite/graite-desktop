import { useState } from "react";
import { CalendarClock, Check, FileText, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PagePicker } from "@/editor/PagePicker";
import { findNode } from "@/editor/tree-utils";
import type { TreeNode } from "@/lib/api";
import type { Scope } from "@/lib/ai";
import type { AgentBody } from "@/lib/automation";
import { scopeLabel, checkedFromScope, countSelected } from "@/lib/scope";
import { ModelSelect } from "@/models/ModelSelect";
import { useModelOptions } from "@/models/useModelOptions";
import { ScheduleBuilder } from "./ScheduleBuilder";
import { ScopeDialog } from "./ScopeDialog";

const TOOLS = [
  ["read_page", "Read pages"],
  ["list_children", "List subpages"],
  ["search_vault", "Search knowledge"],
  ["load_skill", "Use skills"],
  ["schedule", "Schedule follow-up work"],
  ["propose_edit", "Propose edits"],
  ["propose_append", "Propose additions"],
  ["propose_create", "Propose new pages"],
  ["propose_delete", "Propose deletions"],
  ["propose_move", "Propose moves"],
  ["list_proposals", "Read proposals"],
];

export function AgentSettings({
  draft,
  onChange,
  tree,
}: {
  draft: AgentBody;
  onChange: (patch: Partial<AgentBody>) => void;
  tree: TreeNode[];
}) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const [triggerPicker, setTriggerPicker] = useState<number | null>(null);
  const { groups } = useModelOptions(1);
  const scope = (draft.scope ?? { kind: "vault", roots: [], excluded: [] }) as Scope;
  const triggers = draft.triggers ?? [];
  return (
    <div className="agent-settings">
      <section>
        <h2>
          <Zap size={18} /> Triggers
        </h2>
        <p>Choose when this agent runs.</p>
        <div className="agent-settings-card">
          <div className="agent-setting-row">
            <div>
              <strong>Run manually</strong>
              <small>Start a run from this agent’s workspace.</small>
            </div>
            <span className="agent-pill">Always available</span>
          </div>
          {triggers.map((trigger, i) => (
            <div className="agent-trigger" key={i}>
              <div className="agent-trigger-head">
                <ModelSelect
                  label={`Trigger ${i + 1} event`}
                  value={trigger.event}
                  onValueChange={(value) =>
                    onChange({
                      triggers: triggers.map((t, j) =>
                        j === i ? { ...t, event: value as typeof t.event } : t,
                      ),
                    })
                  }
                >
                  <option value="page_created">When a page is created</option>
                  <option value="page_updated">When a page is updated</option>
                </ModelSelect>
                <input
                  type="checkbox"
                  aria-label={`Trigger ${i + 1} enabled`}
                  checked={trigger.enabled ?? true}
                  onChange={(e) =>
                    onChange({
                      triggers: triggers.map((t, j) =>
                        j === i ? { ...t, enabled: e.target.checked } : t,
                      ),
                    })
                  }
                />
                <button
                  aria-label={`Remove trigger ${i + 1}`}
                  onClick={() => onChange({ triggers: triggers.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <button className="agent-page-choice" onClick={() => setTriggerPicker(i)}>
                <FileText size={15} />
                {findNode(tree, trigger.path)?.title ?? trigger.path}
                <span>and subpages</span>
              </button>
            </div>
          ))}
          <button className="agent-add" onClick={() => setTriggerPicker(triggers.length)}>
            <Plus size={15} /> Add page trigger
          </button>
        </div>
        <small>
          Page triggers run after edits settle, within the agent’s page access. Graite must be
          running.
        </small>
      </section>
      <section>
        <h2>
          <CalendarClock size={18} /> Schedule
        </h2>
        <p>Run at a recurring time, in UTC.</p>
        <div className="agent-settings-card agent-settings-fields">
          <ScheduleBuilder
            value={draft.schedule ?? null}
            allowNone
            onChange={(schedule) => onChange({ schedule })}
          />
          <small>
            Scheduled runs require Graite to be open. Pause active schedules in the Schedules tab.
          </small>
        </div>
      </section>
      <section>
        <h2>Tools and knowledge</h2>
        <p>Choose which pages and tools the agent can use.</p>
        <div className="agent-settings-card">
          <div className="agent-setting-row">
            <div>
              <strong>Knowledge pages</strong>
              <small>Instruction links respect these permissions.</small>
            </div>
            <Button variant="outline" size="sm" onClick={() => setScopeOpen(true)}>
              {scopeLabel(scope, countSelected(tree, checkedFromScope(tree, scope)))}
            </Button>
          </div>
          <div className="agent-setting-row">
            <div>
              <strong>Behavior</strong>
              <small>Each page decides: apply automatically, ask first, or disallow changes.</small>
            </div>
            <ModelSelect
              label="Agent mode"
              value={draft.mode}
              onValueChange={(mode) => onChange({ mode })}
            >
              <option value="act">Follow page permissions</option>
              <option value="ask">Answer only</option>
            </ModelSelect>
          </div>
          <div className="agent-tool-list">
            {TOOLS.map(([tool, label]) => {
              const selected = draft.tools == null || draft.tools.includes(tool);
              const unavailable = draft.mode === "ask" && tool.startsWith("propose_");
              return (
                <button
                  type="button"
                  className="agent-tool-pill"
                  key={tool}
                  aria-pressed={selected}
                  disabled={unavailable}
                  title={unavailable ? "Enable Follow page permissions to use this tool" : label}
                  onClick={() => {
                    const chosen = new Set(draft.tools ?? TOOLS.map(([t]) => t));
                    if (selected) chosen.delete(tool);
                    else chosen.add(tool);
                    onChange({ tools: [...chosen] });
                  }}
                >
                  {selected ? <Check size={13} /> : <Plus size={13} />}
                  {label}
                </button>
              );
            })}
            <button className="agent-add" onClick={() => onChange({ tools: null })}>
              Use all tools available for this mode
            </button>
          </div>
        </div>
      </section>
      <section>
        <h2>Model</h2>
        <p>The model used when this agent runs and when you configure it in chat.</p>
        <ModelSelect
          label="Agent model"
          value={draft.model ?? ""}
          onValueChange={(model) => onChange({ model: model || null })}
        >
          <option value="">Vault default</option>
          {draft.model && !groups.some((g) => g.options.some((o) => o.key === draft.model)) && (
            <option value={draft.model}>{draft.model}</option>
          )}
          {groups.flatMap((g) =>
            g.options.map((o) => (
              <option key={o.key} value={o.key}>
                {g.name} · {o.label}
              </option>
            )),
          )}
        </ModelSelect>
      </section>
      <PagePicker
        open={triggerPicker !== null}
        tree={tree}
        excludePath={null}
        onCancel={() => setTriggerPicker(null)}
        onPick={(page) => {
          if (triggerPicker === null) return;
          const next = [...triggers];
          next[triggerPicker] = {
            event: next[triggerPicker]?.event ?? "page_created",
            enabled: next[triggerPicker]?.enabled ?? true,
            path: page.path,
          };
          onChange({ triggers: next });
          setTriggerPicker(null);
        }}
      />
      <ScopeDialog
        open={scopeOpen}
        tree={tree}
        scope={scope}
        onApply={(scope) => {
          onChange({ scope });
          setScopeOpen(false);
        }}
        onCancel={() => setScopeOpen(false)}
      />
    </div>
  );
}
