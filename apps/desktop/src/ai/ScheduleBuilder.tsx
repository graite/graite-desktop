import { useEffect, useState } from "react";
import { ChevronRight, Clock } from "lucide-react";
import {
  DAY_SHORT,
  HOUR_STEPS,
  MINUTE_STEPS,
  WEEK,
  defaultSpec,
  describeSpec,
  todayUTC,
  fromCron,
  isCronShape,
  localTimeHint,
  partsOf,
  timeOf,
  toCron,
  type ScheduleKind,
  type ScheduleSpec,
} from "@/lib/schedule";
import { ModelSelect } from "@/models/ModelSelect";
import "@/models/ai.css";
import "./schedule-builder.css";

const KINDS: [ScheduleKind, string][] = [
  ["minutes", "Every minute"],
  ["hourly", "Every hour"],
  ["daily", "Every day"],
  ["weekdays", "Every weekday"],
  ["weekly", "Every week"],
  ["monthly", "Every month"],
  ["custom", "Custom (cron)"],
];
const two = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 12 }, (_, h) => h + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, i) => i + 1);

/** Every minute is available, including values such as :07 or :37. */
function MinuteSelect({ value, onChange }: { value: number; onChange: (minute: number) => void }) {
  const minutes = MINUTES.includes(value) ? MINUTES : [...MINUTES, value].sort((a, b) => a - b);
  return (
    <ModelSelect label="Minute" value={value} onValueChange={(v) => onChange(Number(v))}>
      {minutes.map((m) => (
        <option key={m} value={m}>
          {two(m)}
        </option>
      ))}
    </ModelSelect>
  );
}

function TimeRow({ time, onChange }: { time: string; onChange: (time: string) => void }) {
  const [hour, minute] = partsOf(time);
  const hint = localTimeHint(time);
  return (
    <div className="sched-row">
      <span className="sched-label">At</span>
      <div className="sched-controls">
        <ModelSelect
          label="Hour"
          value={hour % 12 || 12}
          onValueChange={(v) => onChange(timeOf((Number(v) % 12) + (hour >= 12 ? 12 : 0), minute))}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </ModelSelect>
        <span className="sched-colon">:</span>
        <MinuteSelect value={minute} onChange={(m) => onChange(timeOf(hour, m))} />
        <ModelSelect
          label="AM or PM"
          value={hour >= 12 ? "PM" : "AM"}
          onValueChange={(period) =>
            onChange(timeOf((hour % 12) + (period === "PM" ? 12 : 0), minute))
          }
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </ModelSelect>
        <span className="sched-zone">UTC</span>
        {hint && <span className="sched-hint">{hint}</span>}
      </div>
    </div>
  );
}

/**
 * Pick a recurring time in words. Values use UTC cron for calendar schedules or a
 * fixed interval for cadences cron cannot represent without resetting at boundaries.
 */
export function ScheduleBuilder({
  value,
  onChange,
  allowNone = false,
}: {
  value: string | null;
  onChange: (expr: string | null) => void;
  allowNone?: boolean;
}) {
  // Typing cron by hand keeps the builder in Custom until another kind is picked, so a
  // half-typed expression never makes the friendly controls jump around.
  const [chosenKind, setChosenKind] = useState<ScheduleKind | null>(null);
  const [forceCustom, setForceCustom] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [text, setText] = useState(value ?? "");
  useEffect(() => {
    setText((current) =>
      current.trim().split(/\s+/).join(" ") === (value ?? "") ? current : (value ?? ""),
    );
  }, [value]);

  const parsed = value ? fromCron(value) : null;
  let spec: ScheduleSpec | null = forceCustom ? { kind: "custom", expr: value ?? "" } : parsed;
  // Cron aliases weekdays/all days; keep the day controls while the user selects them.
  if (
    !forceCustom &&
    chosenKind === "weekly" &&
    (parsed?.kind === "weekdays" || parsed?.kind === "daily")
  ) {
    spec = {
      kind: "weekly",
      days: parsed.kind === "weekdays" ? [1, 2, 3, 4, 5] : [...WEEK],
      time: parsed.time,
    };
  }
  const emit = (next: ScheduleSpec) => {
    setChosenKind(next.kind);
    onChange(toCron(next));
  };
  const pickKind = (kind: string) => {
    if (kind === "none") {
      setForceCustom(false);
      setChosenKind(null);
      onChange(null);
      return;
    }
    setChosenKind(kind as ScheduleKind);
    setForceCustom(kind === "custom");
    if (kind === "custom") setAdvanced(true);
    if (parsed?.kind === kind) return;
    emit(defaultSpec(kind as ScheduleKind, parsed ?? undefined));
  };
  const showCron = spec?.kind === "custom" || advanced;

  return (
    <div className="sched">
      <div className="sched-row">
        <span className="sched-label">Repeat</span>
        <div className="sched-controls">
          <ModelSelect label="Repeat" value={spec?.kind ?? "none"} onValueChange={pickKind}>
            {allowNone && <option value="none">No schedule</option>}
            {KINDS.map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </ModelSelect>
          {spec?.kind === "minutes" && (
            <ModelSelect
              label="Interval"
              value={spec.every}
              onValueChange={(v) => emit({ ...spec, every: Number(v) })}
            >
              {MINUTE_STEPS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "minute" : "minutes"}
                </option>
              ))}
            </ModelSelect>
          )}
          {(spec?.kind === "daily" || spec?.kind === "weekly") && (
            <ModelSelect
              label="Interval"
              value={spec.every ?? 1}
              onValueChange={(v) =>
                emit({ ...spec, every: Number(v), start: spec.start ?? todayUTC() })
              }
            >
              {Array.from({ length: 7 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}{" "}
                  {spec.kind === "daily" ? (n === 1 ? "day" : "days") : n === 1 ? "week" : "weeks"}
                </option>
              ))}
            </ModelSelect>
          )}
          {spec?.kind === "hourly" && (
            <ModelSelect
              label="Interval"
              value={spec.every}
              onValueChange={(v) => emit({ ...spec, every: Number(v) })}
            >
              {HOUR_STEPS.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "every hour" : `every ${n} hours`}
                </option>
              ))}
            </ModelSelect>
          )}
        </div>
      </div>
      {(spec?.kind === "daily" || spec?.kind === "weekly") && (spec.every ?? 1) > 1 && (
        <label className="sched-row">
          <span className="sched-label">Starting{spec.kind === "weekly" ? " week" : ""}</span>
          <input
            aria-label="Starting date"
            type="date"
            value={spec.start ?? todayUTC()}
            onChange={(e) => {
              if (e.target.value) emit({ ...spec, start: e.target.value });
            }}
          />
        </label>
      )}
      {spec?.kind === "hourly" && (
        <div className="sched-row">
          <span className="sched-label">At minute</span>
          <div className="sched-controls">
            <span className="sched-colon">:</span>
            <MinuteSelect value={spec.minute} onChange={(minute) => emit({ ...spec, minute })} />
            <span className="sched-hint">past the hour</span>
          </div>
        </div>
      )}
      {spec?.kind === "weekly" && (
        <div className="sched-row">
          <span className="sched-label">On</span>
          <div className="sched-controls sched-days" role="group" aria-label="Days of the week">
            {WEEK.map((day) => {
              const on = spec.days.includes(day);
              return (
                <button
                  type="button"
                  key={day}
                  className="sched-day"
                  aria-pressed={on}
                  // A weekly schedule needs a day: the last one stays selected.
                  disabled={on && spec.days.length === 1}
                  onClick={() =>
                    emit({
                      ...spec,
                      days: on ? spec.days.filter((d) => d !== day) : [...spec.days, day],
                    })
                  }
                >
                  {DAY_SHORT[day]}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {spec?.kind === "monthly" && (
        <div className="sched-row">
          <span className="sched-label">On day</span>
          <div className="sched-controls">
            <ModelSelect
              label="Day of month"
              value={spec.day}
              onValueChange={(v) => emit({ ...spec, day: v === "last" ? "last" : Number(v) })}
            >
              {DAYS_OF_MONTH.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value="last">Last day</option>
            </ModelSelect>
          </div>
        </div>
      )}
      {spec && "time" in spec && (
        <TimeRow time={spec.time} onChange={(time) => emit({ ...spec, time })} />
      )}
      {spec && spec.kind !== "custom" && (
        <p className="sched-summary">
          <Clock size={13} /> {describeSpec(spec)}
        </p>
      )}
      {spec && (
        <div className="sched-advanced">
          {spec.kind !== "custom" && (
            <button
              type="button"
              className="sched-advanced-toggle"
              aria-expanded={advanced}
              onClick={() => setAdvanced((on) => !on)}
            >
              <ChevronRight
                size={13}
                className={`transition-transform ${advanced ? "rotate-90" : ""}`}
              />
              Advanced
            </button>
          )}
          {showCron && (
            <label className="sched-cron">
              Cron expression
              <input
                aria-label="Cron expression"
                placeholder="0 9 * * 1-5"
                spellCheck={false}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setForceCustom(true);
                  onChange(e.target.value.trim().split(/\s+/).join(" ") || null);
                }}
              />
              <small data-invalid={(text.trim() !== "" && !isCronShape(text)) || undefined}>
                Five-field cron or the interval expression generated above. All times UTC; weeks
                start on Monday.
              </small>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
