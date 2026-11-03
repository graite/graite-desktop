---
title: Transactions
icon: 💳
---

Every payment and income: positive is money in, negative is money out.

```graite:table
views:
  - name: All transactions
    source: transactions
    view: table
    sort: date desc
    columns:
      - date
      - description
      - amount
      - category
      - account
      - receipt
      - note
height: 620
```
