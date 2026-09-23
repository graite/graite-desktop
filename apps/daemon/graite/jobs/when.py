"""Turn "in 5 minutes", "tomorrow", an ISO time or a cron expression into a schedule."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

from croniter import croniter

_RELATIVE = re.compile(r"^in\s+(\d+(?:\.\d+)?)\s*([a-z]+)$")
_UNITS = {
    "minute": "minutes",
    "minutes": "minutes",
    "min": "minutes",
    "mins": "minutes",
    "m": "minutes",
    "hour": "hours",
    "hours": "hours",
    "hr": "hours",
    "hrs": "hours",
    "h": "hours",
    "day": "days",
    "days": "days",
    "d": "days",
    "week": "weeks",
    "weeks": "weeks",
    "w": "weeks",
}


# Fixed intervals do not use cron steps: */7 resets at each hour and is not every
# seven minutes. Calendar intervals carry an explicit start date across restarts.
_INTERVAL = re.compile(
    r"^@every (\d+) (minutes|hours|days|weeks)"
    r"(?: on ([0-6](?:,[0-6])*))?(?: at (\d{1,2}(?::\d{2})?))?"
    r"(?: from (\d{4}-\d{2}-\d{2}))?$"
)


def parse_interval(expr: str) -> tuple[int, str, list[int], int, int, datetime] | None:
    if not expr.startswith("@every"):
        return None
    match = _INTERVAL.fullmatch(expr)
    if not match:
        raise ValueError("Invalid recurring interval. Choose an interval in the schedule builder.")
    amount, unit, days_text, time, start = match.groups()
    every = int(amount)
    limit = {"minutes": 60, "hours": 24, "days": 7, "weeks": 7}[unit]
    if not 1 <= every <= limit:
        raise ValueError(f"Choose between 1 and {limit} {unit}.")
    hour, minute = 0, 0
    anchor = datetime(1970, 1, 1, tzinfo=UTC)
    days = [int(d) for d in days_text.split(",")] if days_text else []
    valid = False
    if unit == "minutes":
        valid = time is None and start is None and not days
    elif unit == "hours":
        valid = time is not None and ":" not in time and start is None and not days
        minute = int(time) if valid else 0
    else:
        valid = bool(time and ":" in time and start and (bool(days) == (unit == "weeks")))
        if valid:
            hour, minute = (int(n) for n in time.split(":"))
            anchor = datetime.fromisoformat(start).replace(tzinfo=UTC)
            if unit == "weeks":
                anchor -= timedelta(days=anchor.weekday())
    if not valid or hour > 23 or minute > 59:
        raise ValueError("Invalid interval time or days. Choose a schedule in the builder.")
    return every, unit, days, hour, minute, anchor


def is_cron(when: str) -> bool:
    if when.strip().startswith("@every"):
        try:
            return parse_interval(when.strip()) is not None
        except ValueError:
            return False
    parts = when.strip().split()
    return len(parts) == 5 and croniter.is_valid(" ".join(parts))


def parse_when(when: str, *, now: datetime | None = None) -> datetime:
    """A UTC time for `now`, `tomorrow`, `in N <unit>` or an ISO-8601 stamp."""
    base = now or datetime.now(UTC)
    text = when.strip().lower()
    if text in ("now", "asap"):
        return base
    if text == "tomorrow":
        return (base + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    if text == "tonight":
        return base.replace(hour=20, minute=0, second=0, microsecond=0)
    match = _RELATIVE.match(text)
    if match:
        amount, unit = float(match.group(1)), _UNITS.get(match.group(2))
        if unit is None:
            raise ValueError(f"Unknown time unit in '{when}'.")
        return base + timedelta(**{unit: amount})
    try:
        parsed = datetime.fromisoformat(when.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(
            f"Cannot read the time '{when}'. Use 'in 2 hours', 'tomorrow', an ISO time or a "
            "cron expression."
        ) from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def next_run(expr: str, after: datetime) -> datetime:
    interval = parse_interval(expr)
    if interval:
        every, unit, days, hour, minute, anchor = interval
        after = after.astimezone(UTC) if after.tzinfo else after.replace(tzinfo=UTC)
        anchor += timedelta(hours=hour, minutes=minute)
        period = timedelta(**{unit: every})
        cycle = max(0, (after - anchor) // period)
        if unit != "weeks":
            candidate = anchor + cycle * period
            return candidate if candidate > after else candidate + period
        # Cron Sunday=0; the recurrence week starts on Monday.
        for offset in (cycle, cycle + 1):
            for day in sorted({(day + 6) % 7 for day in days}):
                candidate = anchor + offset * period + timedelta(days=day)
                if candidate > after:
                    return candidate
        raise ValueError("A weekly interval needs at least one day.")
    following: datetime = croniter(expr, after).get_next(datetime)
    return following if following.tzinfo else following.replace(tzinfo=UTC)


def interval_seconds(expr: str, after: datetime) -> float:
    first = next_run(expr, after)
    second = next_run(expr, first)
    return max(60.0, (second - first).total_seconds())
