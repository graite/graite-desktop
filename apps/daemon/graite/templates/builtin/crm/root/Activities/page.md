---
title: Activities
icon: 🗒️
---

Calls, emails, meetings, tasks and notes, each linked to a deal, company and contact.

```graite:table
views:
  - name: All activities
    source: activities
    view: table
    sort: date desc
    columns:
      - title
      - type
      - date
      - due
      - done
      - company
      - contact
      - deal
      - description
  - name: Open tasks
    source: activities
    view: table
    filter: type = "Task" and done = false
    sort: due asc
    columns:
      - title
      - due
      - deal
      - company
      - contact
height: 620
```
