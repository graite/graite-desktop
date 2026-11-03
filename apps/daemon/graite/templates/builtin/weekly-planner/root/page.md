---
title: Weekly planner
icon: 🧭
---

> [!tip] The weekly rhythm
> **Monday, 15 minutes:** add the week to **Weeks**, write one focus and link the goals it serves; add three priorities per day to **Priorities**, each linked to the week. **Every morning:** look at today's column below. **Friday, 15 minutes:** mark what is done, move the rest, open the week and write the review.

```graite:dashboard
src: _dashboards/week.html
```

```graite:table
views:
  - name: Open priorities by day
    source: priorities
    view: board
    group: day
    filter: status != "Done" and status != "Moved"
    show:
      - area
      - week
      - goal
    boards:
      order:
        - Mon
        - Tue
        - Wed
        - Thu
        - Fri
        - Sat
        - Sun
      hidden:
        - ""
height: 420
```

## Databases

[[Weeks]]

[[Priorities]]

[[Goals]]
