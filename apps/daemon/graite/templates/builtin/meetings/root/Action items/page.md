---
title: Action items
icon: ✅
---

What was agreed in meetings, with an owner, a due date and the meeting it came from.

```graite:table
views:
  - name: Board
    source: actions
    view: board
    group: status
    sort: due asc
    show:
      - owner
      - due
      - meeting
    boards:
      order:
        - Open
        - Doing
        - Done
      hidden:
        - ""
  - name: By person
    source: actions
    view: board
    group: owner
    filter: status != "Done"
    sort: due asc
    show:
      - due
      - meeting
  - name: All actions
    source: actions
    view: table
    sort: due asc
    columns:
      - item
      - owner
      - due
      - status
      - meeting
      - note
height: 620
```
