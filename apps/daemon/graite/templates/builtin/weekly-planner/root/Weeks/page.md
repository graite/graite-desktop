---
title: Weeks
icon: 📆
---

One record per week with its focus, energy and rating. Open a week to see its priorities and goals, and to write the review: it starts with Focus, Wins, Lessons and Next week.

```graite:table
views:
  - name: All weeks
    source: weeks
    view: list
    sort: week_start desc
    show:
      - focus
      - energy
      - rating
  - name: Table
    source: weeks
    view: table
    sort: week_start desc
height: 620
```
