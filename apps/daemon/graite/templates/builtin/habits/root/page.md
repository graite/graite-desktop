---
title: Habits
icon: ✅
---

> [!tip] How it works
> Add your **habits** with a target per week (7 is every day). Each day you do one, add a row to the **log** with the date and the habit; _amount_ is optional (minutes, pages, kilometres). The dashboard counts streaks and this week's progress against the target.

```graite:dashboard
src: _dashboards/habits.html
```

```graite:table
views:
  - name: Recent log
    source: log
    view: table
    sort: date desc
    columns:
      - date
      - habit
      - done
      - amount
      - note
height: 320
```

## Databases

[[Habits]]

[[Log]]
