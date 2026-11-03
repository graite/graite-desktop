---
title: Interviews
icon: 🗓️
---

Every interview with its score and recommendation.

```graite:table
views:
  - name: By date
    source: interviews
    view: list
    sort: date desc
    show:
      - candidate
      - date
      - type
      - score
      - recommendation
  - name: Table
    source: interviews
    view: table
    sort: date desc
height: 620
```
