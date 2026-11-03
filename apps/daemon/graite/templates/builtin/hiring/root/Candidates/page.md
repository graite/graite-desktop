---
title: Candidates
icon: 🧑
---

Everyone who applied, with their stage. Open one to see their interviews and CV.

```graite:table
views:
  - name: Pipeline
    source: candidates
    view: board
    group: stage
    sort: applied_on desc
    show:
      - role
      - rating
      - applied_on
    boards:
      order:
        - Applied
        - Screening
        - Interview
        - Assignment
        - Offer
        - Hired
        - Rejected
        - Withdrawn
      hidden:
        - ""
        - Rejected
        - Withdrawn
  - name: All candidates
    source: candidates
    view: table
    sort: applied_on desc
    columns:
      - name
      - role
      - stage
      - source
      - rating
      - applied_on
      - stage_changed_on
      - days_in_process
      - cv
height: 620
```
