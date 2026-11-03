---
title: Invoices
icon: 🧾
---

Everything you invoiced: net, VAT and total, status and when it was paid. Attach the PDF to each one.

```graite:table
views:
  - name: All invoices
    source: invoices
    view: table
    sort: issue_date desc
    columns:
      - number
      - customer
      - issue_date
      - due_date
      - description
      - category
      - net
      - vat_rate
      - vat
      - total
      - status
      - paid_on
      - account
      - document
  - name: By status
    source: invoices
    view: board
    group: status
    sort: due_date asc
    show:
      - customer
      - total
      - due_date
    boards:
      order:
        - Draft
        - Sent
        - Overdue
        - Paid
        - Void
      hidden:
        - ""
        - Void
height: 620
```
