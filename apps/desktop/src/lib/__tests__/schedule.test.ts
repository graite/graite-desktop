import { describe, expect, it } from "vitest";
import {
  describeCron,
  fromCron,
  isCronShape,
  localTimeHint,
  toCron,
  type ScheduleSpec,
} from "../schedule";

const SPECS: [ScheduleSpec, string, string][] = [
  [{ kind: "minutes", every: 15 }, "*/15 * * * *", "Every 15 minutes"],
  [{ kind: "hourly", every: 1, minute: 5 }, "5 * * * *", "Every hour at :05"],
  [{ kind: "hourly", every: 6, minute: 0 }, "0 */6 * * *", "Every 6 hours at :00"],
  [{ kind: "daily", time: "09:00" }, "0 9 * * *", "Every day at 09:00 UTC"],
  [{ kind: "weekdays", time: "07:30" }, "30 7 * * 1-5", "Weekdays at 07:30 UTC"],
  [{ kind: "weekly", days: [1], time: "07:00" }, "0 7 * * 1", "Mondays at 07:00 UTC"],
  [
    { kind: "weekly", days: [1, 4], time: "07:30" },
    "30 7 * * 1,4",
    "Mondays and Thursdays at 07:30 UTC",
  ],
  [
    { kind: "weekly", days: [0, 1, 3], time: "18:00" },
    "0 18 * * 0,1,3",
    "Mon, Wed and Sun at 18:00 UTC",
  ],
  [{ kind: "monthly", day: 1, time: "09:00" }, "0 9 1 * *", "Monthly on the 1st at 09:00 UTC"],
  [
    { kind: "monthly", day: "last", time: "23:55" },
    "55 23 L * *",
    "Monthly on the last day at 23:55 UTC",
  ],
];

describe("schedule specs", () => {
  it.each(SPECS)("round-trips %j", (spec, cron, words) => {
    expect(toCron(spec)).toBe(cron);
    expect(fromCron(cron)).toEqual(spec);
    expect(describeCron(cron)).toBe(words);
  });

  it("reads equivalent spellings", () => {
    expect(fromCron("  0   9 * * 7 ")).toEqual({ kind: "weekly", days: [0], time: "09:00" });
    expect(fromCron("0 9 * * 1,2,3,4,5")).toEqual({ kind: "weekdays", time: "09:00" });
    expect(fromCron("0 9 * * 1-3,6")).toEqual({
      kind: "weekly",
      days: [1, 2, 3, 6],
      time: "09:00",
    });
    expect(fromCron("0 9 * * 0-6")).toEqual({ kind: "daily", time: "09:00" });
    expect(fromCron("0 9 l * *")).toEqual({ kind: "monthly", day: "last", time: "09:00" });
  });

  it("keeps everything else as a custom expression", () => {
    for (const expr of [
      "*/7 * * * *",
      "0 9 1 * 1",
      "0 9 31 * *",
      "0 9 * 6 *",
      "0 9,17 * * *",
      "0 9 * * MON",
      "* * * *",
      "0 0 9 * * *",
    ]) {
      expect(fromCron(expr)).toEqual({ kind: "custom", expr });
      expect(describeCron(expr)).toBe(expr);
    }
  });

  it("checks the shape of a typed expression", () => {
    expect(isCronShape("0 9 * * MON-FRI")).toBe(true);
    expect(isCronShape("0 9 * *")).toBe(false);
    expect(isCronShape("every day")).toBe(false);
  });
});

describe("localTimeHint", () => {
  it("follows daylight saving and flags a date shift", () => {
    const summer = new Date("2026-07-01T12:00:00Z");
    const winter = new Date("2026-01-15T12:00:00Z");
    expect(localTimeHint("09:00", { now: summer, timeZone: "Europe/Amsterdam" })).toBe(
      "11:00 your time",
    );
    expect(localTimeHint("09:00", { now: winter, timeZone: "Europe/Amsterdam" })).toBe(
      "10:00 your time",
    );
    expect(localTimeHint("23:30", { now: winter, timeZone: "Europe/Amsterdam" })).toBe(
      "00:30 your time (next day)",
    );
    expect(localTimeHint("02:00", { now: winter, timeZone: "America/New_York" })).toBe(
      "21:00 your time (previous day)",
    );
    expect(localTimeHint("09:00", { now: winter, timeZone: "UTC" })).toBe("");
  });
});

it("supports every minute/hour value and anchored day/week intervals", () => {
  for (let every = 1; every <= 60; every++) {
    const spec: ScheduleSpec = { kind: "minutes", every };
    expect(fromCron(toCron(spec))).toEqual(spec);
    expect(isCronShape(toCron(spec))).toBe(true);
  }
  for (let every = 1; every <= 24; every++) {
    const spec: ScheduleSpec = { kind: "hourly", every, minute: 37 };
    expect(fromCron(toCron(spec))).toEqual(spec);
    expect(isCronShape(toCron(spec))).toBe(true);
  }
  for (let every = 2; every <= 7; every++) {
    const daily: ScheduleSpec = { kind: "daily", every, time: "12:37", start: "2026-09-21" };
    const weekly: ScheduleSpec = {
      kind: "weekly",
      every,
      days: [1, 4],
      time: "12:30",
      start: "2026-09-21",
    };
    expect(fromCron(toCron(daily))).toEqual(daily);
    expect(fromCron(toCron(weekly))).toEqual(weekly);
  }
  expect(toCron({ kind: "minutes", every: 7 })).toBe("@every 7 minutes");
  expect(toCron({ kind: "hourly", every: 5, minute: 30 })).toBe("@every 5 hours at 30");
  expect(isCronShape("@every 2 days at 12:30 from 2026-02-30")).toBe(false);
});
