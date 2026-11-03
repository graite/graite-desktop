---
title: Receipts
icon: 🧾
---

Everything you bought: net, VAT and total, and whether it is paid. Attach the receipt to each one.

```graite:table
views:
  - name: All receipts
    source: receipts
    view: table
    sort: date desc
    columns:
      - date
      - supplier
      - description
      - category
      - net
      - vat_rate
      - vat
      - total
      - paid
      - paid_on
      - account
      - receipt
  - name: Unpaid
    source: receipts
    view: table
    filter: paid = false
    sort: date asc
    columns:
      - date
      - supplier
      - description
      - total
height: 620
```
