---
title: Meetings
icon: 🗓️
---

Every meeting with its date, type and attendees. Add one with **+ New**, then open it to write the notes: they start with Agenda, Notes and Decisions. Its action items are listed on it.

```graite:table
views:
  - name: All meetings
    source: meetings
    view: list
    sort: date desc
    show:
      - date
      - type
      - attendees
  - name: Table
    source: meetings
    view: table
    sort: date desc
height: 620
```
