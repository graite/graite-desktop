---
title: OKRs
icon: 🎯
---

> [!tip] How it works
> Write a few **objectives** for the quarter: what you want to achieve, in words. Give each two to four **key results**: numbers with a start, a target and the current value; progress is computed. Every week, add a **check-in** per key result with the new value and how confident you are (1 to 10) that you will make it, then update _current_ on the key result.

```graite:dashboard
src: _dashboards/progress.html
```

```graite:table
views:
  - name: Key results
    source: key_results
    view: table
    columns:
      - title
      - objective
      - current
      - target
      - unit
      - progress
      - confidence
height: 360
```

## Databases

[[Objectives]]

[[Key results]]

[[Check-ins]]
