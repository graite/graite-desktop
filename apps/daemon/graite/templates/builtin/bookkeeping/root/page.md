---
title: Bookkeeping
icon: 📒
---

> [!tip] How these books work
> Enter what you sell as **invoices** and what you buy as **receipts**: the amount without VAT (_net_) and the VAT rate; Graite computes the VAT and the total. Attach the PDF or photo in the _document_ or _receipt_ field. Mark an invoice _Paid_ with the date and the account the money came in on, and a receipt _paid_ the same way. Money that is neither (your own contributions, drawings, VAT payments, transfers between accounts, loans) goes in **movements**: positive is money in, negative is money out. Every invoice and receipt gets a **category**, and each category belongs to a section of the profit & loss statement.

```graite:dashboard
src: _dashboards/profit-and-loss.html
```

```graite:dashboard
src: _dashboards/balance-sheet.html
```

```graite:table
views:
  - name: Open invoices
    source: invoices
    view: table
    filter: status = "Sent" or status = "Overdue"
    sort: due_date asc
    columns:
      - number
      - customer
      - issue_date
      - due_date
      - total
      - status
height: 320
```

## Databases

[[Invoices]]

[[Receipts]]

[[Movements]]

[[Parties]]

[[Categories]]

[[Accounts]]
