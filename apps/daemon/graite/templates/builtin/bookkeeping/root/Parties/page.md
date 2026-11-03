---
title: Parties
icon: 👥
---

Your customers and suppliers. Open one to see its invoices or receipts.

```graite:table
views:
  - name: All parties
    source: parties
    view: list
    sort: name asc
    show:
      - kind
      - email
      - vat_number
  - name: Table
    source: parties
    view: table
height: 620
```
