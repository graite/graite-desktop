import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const LONG = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const build = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? iso(y, m, d)
    : null;
};
const todayIso = () => {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
};
const monthIndex = (name: string) =>
  name.length >= 3 ? LONG.findIndex((m) => m.startsWith(name)) : -1;

const monthName = (m: number) =>
  LONG[m - 1] ? LONG[m - 1][0].toUpperCase() + LONG[m - 1].slice(1) : String(m);

/** "2026-09-15" → "September 15, 2026". Anything that is not an ISO date is returned unchanged. */
export function formatDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${monthName(Number(m[2]))} ${Number(m[3])}, ${m[1]}` : value;
}

/** Typed dates → ISO: "September 15, 2026", "15 sept 2026", "15/9/2026", "2026-09-15", "today". */
export function parseDateInput(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  if (t === "today") return todayIso();
  if (t === "tomorrow" || t === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() + (t === "tomorrow" ? 1 : -1));
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s./-]*([a-z]+)\.?[\s,.]*(\d{4})$/.exec(t);
  if (m) {
    const mo = monthIndex(m[2]);
    return mo < 0 ? null : build(+m[3], mo + 1, +m[1]);
  }
  m = /^([a-z]+)\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})$/.exec(t);
  if (m) {
    const mo = monthIndex(m[1]);
    return mo < 0 ? null : build(+m[3], mo + 1, +m[2]);
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  if (m) return build(+m[3], +m[2], +m[1]);
  return null;
}

function monthCells(year: number, month: number): (number | null)[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
}

/** A date value shown as text ("September 15, 2026"); edit by typing a date or picking one in the calendar. */
export function DateField({
  value,
  label,
  disabled = false,
  onChange,
}: {
  value: string | null;
  label: string;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const today = todayIso();
  const [[year, month], setMonth] = useState<[number, number]>(() => {
    const src = value || today;
    return [+src.slice(0, 4), +src.slice(5, 7)];
  });
  useEffect(() => {
    if (open) {
      setText(value ? formatDate(value) : "");
      setInvalid(false);
      const src = value || today;
      setMonth([+src.slice(0, 4), +src.slice(5, 7)]);
    }
  }, [open, value, today]);

  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  const commit = () => {
    if (!text.trim()) {
      pick(null);
      return;
    }
    const parsed = parseDateInput(text);
    if (parsed) pick(parsed);
    else setInvalid(true);
  };
  const shift = (delta: number) =>
    setMonth(([y, m]) => {
      const d = new Date(Date.UTC(y, m - 1 + delta, 1));
      return [d.getUTCFullYear(), d.getUTCMonth() + 1];
    });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="date-field-trigger" aria-label={label} disabled={disabled}>
        {value ? formatDate(value) : <span className="property-empty">Empty</span>}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="date-field-menu"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          aria-label={`${label} as text`}
          value={text}
          placeholder="September 15, 2026"
          autoFocus
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") setOpen(false);
          }}
        />
        {invalid && (
          <small className="date-field-error">
            Use a date like September 15, 2026 or 2026-09-15.
          </small>
        )}
        <div className="date-field-nav">
          <button type="button" aria-label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft size={14} />
          </button>
          <span>
            {monthName(month)} {year}
          </span>
          <button type="button" aria-label="Next month" onClick={() => shift(1)}>
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="date-field-grid" role="grid">
          {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
            <span key={d}>{d}</span>
          ))}
          {monthCells(year, month).map((day, i) =>
            day === null ? (
              <span key={`pad${i}`} />
            ) : (
              (() => {
                const date = iso(year, month, day);
                return (
                  <button
                    type="button"
                    key={date}
                    aria-label={formatDate(date)}
                    aria-selected={date === value}
                    data-today={date === today ? "" : undefined}
                    onClick={() => pick(date)}
                  >
                    {day}
                  </button>
                );
              })()
            ),
          )}
        </div>
        <div className="date-field-actions">
          <button type="button" onClick={() => pick(today)}>
            Today
          </button>
          {value && (
            <button type="button" onClick={() => pick(null)}>
              Clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
