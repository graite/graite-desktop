from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from graite.jobs.when import interval_seconds, is_cron, next_run, parse_when

NOW = datetime(2026, 9, 16, 10, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("when", "expected"),
    [
        ("now", NOW),
        ("in 5 minutes", NOW + timedelta(minutes=5)),
        ("in 2 hours", NOW + timedelta(hours=2)),
        ("in 1 day", NOW + timedelta(days=1)),
        ("in 2 weeks", NOW + timedelta(weeks=2)),
        ("tomorrow", datetime(2026, 9, 17, 9, 0, tzinfo=UTC)),
        ("2026-10-01T08:30:00Z", datetime(2026, 10, 1, 8, 30, tzinfo=UTC)),
        ("2026-10-01T08:30:00", datetime(2026, 10, 1, 8, 30, tzinfo=UTC)),
    ],
)
def test_parse_when(when: str, expected: datetime) -> None:
    assert parse_when(when, now=NOW) == expected


def test_parse_when_rejects_nonsense() -> None:
    with pytest.raises(ValueError, match="Cannot read the time"):
        parse_when("whenever", now=NOW)
    with pytest.raises(ValueError, match="Unknown time unit"):
        parse_when("in 3 fortnights", now=NOW)


def test_cron_helpers() -> None:
    assert is_cron("0 7 * * 1-5") and not is_cron("in 5 minutes") and not is_cron("* * * *")
    assert next_run("0 7 * * *", NOW) == datetime(2026, 9, 17, 7, 0, tzinfo=UTC)
    assert interval_seconds("*/2 * * * *", NOW) == 120.0
    assert interval_seconds("* * * * *", NOW) == 60.0


@pytest.mark.parametrize(
    ("expr", "seconds"),
    [
        ("@every 7 minutes", 420),
        ("@every 59 minutes", 3540),
        ("@every 60 minutes", 3600),
        ("@every 5 hours at 30", 18000),
        ("@every 24 hours at 7", 86400),
    ],
)
def test_fixed_intervals_do_not_reset_at_hour_or_day_boundaries(expr: str, seconds: int) -> None:
    from graite.agents.definitions import validate_cron

    assert validate_cron(expr) == expr
    assert is_cron(expr)
    at = datetime(2026, 9, 30, 23, 58, tzinfo=UTC)
    first = next_run(expr, at)
    for _ in range(70):
        following = next_run(expr, first)
        assert (following - first).total_seconds() == seconds
        if "hours" in expr:
            assert following.minute == int(expr.split()[-1])
        first = following


def test_daily_interval_crosses_months_and_keeps_its_start_date() -> None:
    expr = "@every 3 days at 12:30 from 2026-09-29"
    first = next_run(expr, datetime(2026, 9, 28, tzinfo=UTC))
    assert first == datetime(2026, 9, 29, 12, 30, tzinfo=UTC)
    assert next_run(expr, first) == datetime(2026, 10, 2, 12, 30, tzinfo=UTC)
    assert next_run(expr, datetime(2026, 10, 6, tzinfo=UTC)) == datetime(
        2026, 10, 8, 12, 30, tzinfo=UTC
    )


def test_multiweek_interval_uses_selected_days_in_selected_weeks() -> None:
    expr = "@every 2 weeks on 0,1,4 at 12:30 from 2026-09-21"
    at = datetime(2026, 9, 20, tzinfo=UTC)
    for day in ("2026-09-21", "2026-09-24", "2026-09-27", "2026-10-05"):
        at = next_run(expr, at)
        assert at == datetime.fromisoformat(day + "T12:30:00+00:00")


@pytest.mark.parametrize(
    "expr",
    [
        "@every 0 minutes",
        "@every 61 minutes",
        "@every 25 hours at 30",
        "@every 2 hours",
        "@every 2 hours at 60",
        "@every 8 days at 09:00 from 2026-09-21",
        "@every 2 weeks at 09:00 from 2026-09-21",
        "@every 2 days on 1 at 09:00 from 2026-09-21",
        "@every 2 days at 24:00 from 2026-09-21",
        "@every 2 days at 09:00 from 2026-02-30",
    ],
)
def test_invalid_intervals_are_rejected(expr: str) -> None:
    from graite.agents.definitions import validate_cron

    assert not is_cron(expr)
    with pytest.raises(ValueError):
        validate_cron(expr)
