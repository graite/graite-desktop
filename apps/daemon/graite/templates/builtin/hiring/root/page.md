---
title: Hiring
icon: 🧑‍💼
---

> [!tip] How it works
> Add a **role** for every opening. Each **candidate** applies to one role and moves through the stages; update _stage changed on_ when you move them, so you can see how long people wait. Log every **interview** with a score from 1 to 5 and a recommendation, and keep longer notes on a page linked from the interview. The interview kit has the questions and the scorecard.

```graite:dashboard
src: _dashboards/pipeline.html
```

```graite:table
views:
  - name: Candidate pipeline
    source: candidates
    view: board
    group: stage
    sort: applied_on desc
    show:
      - role
      - rating
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
height: 460
```

## Databases

[[Candidates]]

[[Roles]]

[[Interviews]]

## Guides

[[Interview kit]]

[[Offer checklist]]
