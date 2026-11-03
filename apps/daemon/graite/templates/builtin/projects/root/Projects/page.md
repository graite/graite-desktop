---
title: Projects
icon: 🗂️
---

Your projects. Open one to see its tasks and milestones.

```graite:table
views:
  - name: Board
    source: projects
    view: board
    group: status
    sort: due asc
    show:
      - owner
      - due
      - priority
    boards:
      order:
        - Planned
        - Active
        - On hold
        - Done
      hidden:
        - ""
  - name: Table
    source: projects
    view: table
height: 620
```
