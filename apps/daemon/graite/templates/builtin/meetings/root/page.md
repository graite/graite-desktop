---
title: Meeting notes
icon: 🗓️
---

> [!tip] How it works
> Add each meeting to **Meetings** and open it to write the notes. Add what was agreed as action items on the meeting itself (its Action items list, **+ Add**), each with an owner and a due date. This page shows what is open.

```graite:dashboard
src: _dashboards/actions.html
```

```graite:table
views:
  - name: Open action items
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
    filter: status != "Done"
height: 420
```

## Databases

[[Meetings]]

[[Action items]]
