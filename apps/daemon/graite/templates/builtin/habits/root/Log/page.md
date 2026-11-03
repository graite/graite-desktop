---
title: Log
icon: 📅
---

One row per day you did a habit.

```graite:table
views:
  - name: All entries
    source: log
    view: table
    sort: date desc
    columns:
      - date
      - habit
      - done
      - amount
      - note
height: 620
```
