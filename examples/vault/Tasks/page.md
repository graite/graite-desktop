---
id: 018f3c2e-0000-7000-8000-000000000030
title: Tasks
icon: 🗂️
created: '2026-09-14T00:00:00Z'
updated: '2026-09-14T00:00:00Z'
---

Drag the cards between columns. Switch to Table or List with the tabs, and choose what each card shows under Properties.

```graite:view
settings:
  sort:
    field: Due
    direction: asc
  filters: []
  boards:
    Status:
      order:
        - To do
        - In progress
        - Done
      hidden: []
view: kanban
group: Status
show:
  table:
    - Priority
    - Status
    - Due
  kanban:
    - Due
    - Priority
  list:
    - Status
    - Due
```

<!-- graite:empty -->
