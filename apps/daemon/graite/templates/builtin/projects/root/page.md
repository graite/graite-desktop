---
title: Projects
icon: 🗂️
---

> [!tip] How it works
> Every task belongs to a **project**. Give it an assignee, a due date and an estimate in hours; set it to _Done_ with the date when it's finished. **Milestones** mark the dates that matter. Each project can link to a brief page with the why, the scope and the decisions.

```graite:dashboard
src: _dashboards/overview.html
```

```graite:table
views:
  - name: Task board
    source: tasks
    view: board
    group: status
    sort: due asc
    show:
      - project
      - assignee
      - due
    boards:
      order:
        - To do
        - In progress
        - Blocked
        - Done
      hidden:
        - ""
height: 460
```

## Databases

[[Tasks]]

[[Projects]]

[[Milestones]]

## Guides

[[Website relaunch brief]]
