---
title: Deals
icon: 💼
---

Every deal with its stage, value and expected close. Open one to see its contacts, activities and notes.

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
  - name: All deals
    source: deals
    view: table
    sort: expected_close asc
    columns:
      - name
      - company
      - contacts
      - stage
      - value
      - probability
      - weighted
      - expected_close
      - owner
      - source
  - name: Open deals
    source: deals
    view: table
    filter: stage != "Won" and stage != "Lost"
    sort: expected_close asc
    columns:
      - name
      - company
      - stage
      - value
      - weighted
      - expected_close
      - owner
height: 620
```
