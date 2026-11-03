---
title: Companies
icon: 🏢
---

The organisations you work with. Open one to see its contacts, deals and activities.

```graite:table
views:
  - name: All companies
    source: companies
    view: table
    sort: name asc
    columns:
      - name
      - status
      - industry
      - size
      - city
      - country
      - contacts
      - deals
      - owner
  - name: By status
    source: companies
    view: board
    group: status
    show:
      - industry
      - city
      - deals
    boards:
      order:
        - Lead
        - Prospect
        - Customer
        - Partner
        - Churned
      hidden:
        - ""
height: 620
```
