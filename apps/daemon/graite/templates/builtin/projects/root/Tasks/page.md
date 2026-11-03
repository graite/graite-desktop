---
title: Tasks
icon: ✅
---

Everything to do, each in one project, with an owner, a due date and an estimate.

```graite:table
views:
  - name: Board
    source: tasks
    view: board
    group: status
    sort: due asc
    show:
      - project
      - assignee
      - due
      - priority
    boards:
      order:
        - To do
        - In progress
        - Blocked
        - Done
      hidden:
        - ""
  - name: All tasks
    source: tasks
    view: table
    sort: due asc
    columns:
      - title
      - project
      - status
      - priority
      - assignee
      - due
      - estimate_h
      - hours_left
      - done_on
height: 620
```
