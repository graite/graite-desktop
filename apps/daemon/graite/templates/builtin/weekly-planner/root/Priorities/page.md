---
title: Priorities
icon: ⭐
---

What you plan to do, a few per day, each linked to its week and to the goal it serves.

```graite:table
views:
  - name: By status
    source: priorities
    view: board
    group: status
    sort: day asc
    show:
      - week
      - day
      - area
      - estimate_h
    boards:
      order:
        - Todo
        - Doing
        - Done
        - Moved
      hidden:
        - ""
  - name: By day
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
  - name: All priorities
    source: priorities
    view: table
    columns:
      - title
      - week
      - day
      - area
      - status
      - estimate_h
      - goal
height: 620
```
