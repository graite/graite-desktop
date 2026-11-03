---
title: Personal finance
icon: 💶
---

> [!tip] How it works
> Add every payment and every income to **transactions**: positive amounts are money in, negative amounts money out. Give each one a **category**; categories carry a monthly budget. Moving money between your own accounts is two transactions (out of one, into the other) in the _Transfers_ category, so it never counts as spending. Put things you own or owe outside your accounts (a house, a car, a mortgage) in **assets and liabilities**, with the date of the value.

```graite:dashboard
src: _dashboards/money.html
```

```graite:table
views:
  - name: Recent transactions
    source: transactions
    view: table
    sort: date desc
    columns:
      - date
      - description
      - amount
      - category
      - account
height: 320
```

## Databases

[[Transactions]]

[[Categories]]

[[Accounts]]

[[Assets and liabilities]]
