---
title: CRM
icon: 🤝
---

> [!tip] How this CRM works
> Your deals, companies, contacts and activities each have their own page, with views as tabs (a pipeline board, a full table, …). Drag a deal to its next stage. Open any record to see everything linked to it, as lists you can add to, and to write notes in its own document. This page sums it all up.

```graite:dashboard
src: _dashboards/overview.html
```

```graite:table
views:
  - name: Pipeline
    source: deals
    view: board
    group: stage
    sort: expected_close asc
    show:
      - company
      - value
      - probability
      - expected_close
      - owner
    boards:
      order:
        - Lead
        - Qualified
        - Proposal
        - Negotiation
        - Won
        - Lost
      hidden:
        - ""
        - Lost
height: 480
```

## Databases

[[Deals]]

[[Companies]]

[[Contacts]]

[[Activities]]

## Guides

[[Sales playbook]]

[[Discovery call Northwind]]
