---
title: Contacts
icon: 👤
---

The people at those companies. Open one to see their deals and activities.

```graite:table
views:
  - name: All contacts
    source: contacts
    view: list
    sort: name asc
    show:
      - company
      - role
      - email
      - last_contacted
  - name: Table
    source: contacts
    view: table
    sort: name asc
height: 620
```
