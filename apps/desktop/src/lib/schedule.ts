/**
 * Friendly UTC schedules over cron and fixed intervals. Calendar intervals retain a start
 * date; minute/hour intervals align to the Unix epoch and never reset at field boundaries.
 * Anything it does not recognise is a `custom` spec that keeps the expression verbatim.
 */

export type ScheduleSpec =
  | { kind: "minutes"; every: number }
  | { kind: "hourly"; every: number; minute: number }
  | { kind: "daily"; time: string; every?: number; start?: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string; every?: number; start?: string }
  | { kind: "monthly"; day: number | "last"; time: string }
  | { kind: "custom"; expr: string };

export type ScheduleKind = ScheduleSpec["kind"];

export const MINUTE_STEPS = Array.from({ length: 60 }, (_, i) => i + 1);
export const HOUR_STEPS = Array.from({ length: 24 }, (_, i) => i + 1);
export const todayUTC = () => new Date().toISOString().slice(0, 10);
/** Cron day numbers in the order the week is shown: Monday first, Sunday (0) last. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");
const weekOrder = (a: number, b: number) => WEEK.indexOf(a) - WEEK.indexOf(b);

export function timeOf(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

export function partsOf(time: string): [number, number] {
  const [h, m] = time.split(":").map(Number);
  return [h || 0, m || 0];
}

export function toCron(spec: ScheduleSpec): string {
  if (spec.kind === "custom") return spec.expr.trim().split(/\s+/).join(" ");
  if (spec.kind === "minutes")
    return spec.every < 60 && 60 % spec.every === 0
      ? `*/${spec.every} * * * *`
      : `@every ${spec.every} minutes`;
  if (spec.kind === "hourly")
    return spec.every < 24 && 24 % spec.every === 0
      ? `${spec.minute} ${spec.every === 1 ? "*" : `*/${spec.every}`} * * *`
      : `@every ${spec.every} hours at ${spec.minute}`;
  const [h, m] = partsOf(spec.time);
  if (spec.kind === "daily")
    return (spec.every ?? 1) > 1
      ? `@every ${spec.every} days at ${spec.time} from ${spec.start ?? todayUTC()}`
      : `${m} ${h} * * *`;
  if (spec.kind === "weekdays") return `${m} ${h} * * 1-5`;
  // Day of month and day of week are never combined: cron would run on either.
  if (spec.kind === "weekly" && (spec.every ?? 1) > 1)
    return `@every ${spec.every} weeks on ${[...spec.days].sort((a, b) => a - b).join(",")} at ${spec.time} from ${spec.start ?? todayUTC()}`;
  if (spec.kind === "weekly")
    return `${m} ${h} * * ${[...spec.days].sort((a, b) => a - b).join(",")}`;
  return `${m} ${h} ${spec.day === "last" ? "L" : spec.day} * *`;
}

function int(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/** `1,3-5,7` as a sorted set of cron day numbers (7 is Sunday), or null when it is anything else. */
function dayList(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const [from, to] = part.split("-");
    const a = int(from ?? "", 0, 7);
    const b = to === undefined ? a : int(to, 0, 7);
    if (a === null || b === null || a > b || part.split("-").length > 2) return null;
    for (let d = a; d <= b; d++) days.add(d % 7);
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

export function fromCron(expr: string): ScheduleSpec {
  const clean = expr.trim().split(/\s+/).join(" ");
  const custom: ScheduleSpec = { kind: "custom", expr: clean };
  const interval = /^@every (\d+) (minutes|hours)(?: at (\d+))?$/.exec(clean);
  if (interval) {
    const every = Number(interval[1]);
    if (interval[2] === "minutes" && every >= 1 && every <= 60 && interval[3] === undefined)
      return { kind: "minutes", every };
    const minute = Number(interval[3]);
    if (
      interval[2] === "hours" &&
      every >= 1 &&
      every <= 24 &&
      Number.isInteger(minute) &&
      minute >= 0 &&
      minute <= 59
    )
      return { kind: "hourly", every, minute };
    return custom;
  }
  const calendar =
    /^@every ([2-7]) (days|weeks)(?: on ([0-6](?:,[0-6])*))? at (\d{2}:\d{2}) from (\d{4}-\d{2}-\d{2})$/.exec(
      clean,
    );
  if (calendar) {
    const [, amount, unit, days, time, start] = calendar;
    const [h, m] = partsOf(time!);
    const date = new Date(`${start}T00:00:00Z`);
    if (
      h > 23 ||
      m > 59 ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== start
    )
      return custom;
    if (unit === "days" && !days)
      return { kind: "daily", every: Number(amount), time: time!, start };
    if (unit === "weeks" && days)
      return {
        kind: "weekly",
        every: Number(amount),
        days: days.split(",").map(Number),
        time: time!,
        start,
      };
    return custom;
  }
  const fields = clean.split(" ");
  if (fields.length !== 5) return custom;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (month !== "*") return custom;
  const anyDay = dom === "*" && dow === "*";
  const everyMinutes = /^\*\/(\d+)$/.exec(min);
  if (everyMinutes) {
    const every = Number(everyMinutes[1]);
    return anyDay && hour === "*" && every < 60 && 60 % every === 0
      ? { kind: "minutes", every }
      : custom;
  }
  const minute = int(min, 0, 59);
  if (minute === null) return custom;
  const everyHours = hour === "*" ? 1 : Number(/^\*\/(\d+)$/.exec(hour)?.[1] ?? NaN);
  if (!Number.isNaN(everyHours)) {
    return anyDay && everyHours >= 1 && everyHours < 24 && 24 % everyHours === 0
      ? { kind: "hourly", every: everyHours, minute }
      : custom;
  }
  const h = int(hour, 0, 23);
  if (h === null) return custom;
  const time = timeOf(h, minute);
  if (anyDay) return { kind: "daily", time };
  if (dow === "*") {
    if (dom.toUpperCase() === "L") return { kind: "monthly", day: "last", time };
    const day = int(dom, 1, 28);
    return day === null ? custom : { kind: "monthly", day, time };
  }
  if (dom !== "*") return custom;
  const days = dayList(dow);
  if (!days) return custom;
  if (days.length === 7) return { kind: "daily", time };
  if (days.join(",") === "1,2,3,4,5") return { kind: "weekdays", time };
  return { kind: "weekly", days, time };
}

function ordinal(n: number): string {
  const tail = n % 100;
  if (tail >= 11 && tail <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function describeSpec(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "minutes":
      return spec.every === 1 ? "Every minute" : `Every ${spec.every} minutes`;
    case "hourly":
      return `${spec.every === 1 ? "Every hour" : `Every ${spec.every} hours`} at :${pad(spec.minute)}`;
    case "daily":
      return (spec.every ?? 1) > 1
        ? `Every ${spec.every} days at ${spec.time} UTC, starting ${spec.start}`
        : `Every day at ${spec.time} UTC`;
    case "weekdays":
      return `Weekdays at ${spec.time} UTC`;
    case "weekly": {
      const days = [...spec.days].sort(weekOrder);
      const names =
        days.length > 2 ? days.map((d) => DAY_SHORT[d]!) : days.map((d) => `${DAY_LONG[d]}s`);
      return `${(spec.every ?? 1) > 1 ? `Every ${spec.every} weeks on ` : ""}${joinWords(names)} at ${spec.time} UTC${(spec.every ?? 1) > 1 ? `, starting week of ${spec.start}` : ""}`;
    }
    case "monthly":
      return `Monthly on the ${spec.day === "last" ? "last day" : ordinal(spec.day)} at ${spec.time} UTC`;
    case "custom":
      return spec.expr;
  }
}

/** A schedule in words; an expression the builder does not know is returned as it is. */
export function describeCron(expr: string): string {
  return describeSpec(fromCron(expr));
}

/** Light client-side check. The daemon's validation is the authority and its message is shown. */
export function isCronShape(expr: string): boolean {
  if (expr.trim().startsWith("@every")) return fromCron(expr).kind !== "custom";
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^[\dA-Za-z*/,\-?#]+$/.test(f));
}

/**
 * What a UTC time of day is on the viewer's clock today, e.g. "11:00 your time". Empty when
 * both clocks agree. Offsets move with daylight saving, so this is a hint, not a promise.
 */
export function localTimeHint(time: string, opts: { now?: Date; timeZone?: string } = {}): string {
  const now = opts.now ?? new Date();
  const [h, m] = partsOf(time);
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: opts.timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const local = `${get("hour")}:${get("minute")}`;
  const day = Number(get("day"));
  if (local === time && day === at.getUTCDate()) return "";
  const shift =
    day === at.getUTCDate()
      ? ""
      : day === new Date(at.getTime() + 864e5).getUTCDate()
        ? " (next day)"
        : " (previous day)";
  return `${local} your time${shift}`;
}

/** The spec a kind starts from when it is picked in the builder, keeping the time where it can. */
export function defaultSpec(kind: ScheduleKind, from?: ScheduleSpec): ScheduleSpec {
  const time = from && "time" in from ? from.time : "09:00";
  switch (kind) {
    case "minutes":
      return { kind, every: 15 };
    case "hourly":
      return { kind, every: 1, minute: 0 };
    case "daily":
    case "weekdays":
      return { kind, time };
    case "weekly":
      return { kind, days: from?.kind === "weekly" ? from.days : [1], time };
    case "monthly":
      return { kind, day: 1, time };
    case "custom":
      return { kind, expr: from ? toCron(from) : "0 9 * * *" };
  }
}
