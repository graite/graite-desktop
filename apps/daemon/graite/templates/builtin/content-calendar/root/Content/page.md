---
title: Content
icon: 📝
---

Every piece of content from idea to published, with its channel and campaign.

```graite:table
views:
  - name: Board
    source: content
    view: board
    group: status
    sort: publish_date asc
    show:
      - channel
      - publish_date
      - owner
    boards:
      order:
        - Idea
        - Drafting
        - Review
        - Scheduled
        - Published
      hidden:
        - ""
  - name: Schedule
    source: content
    view: list
    filter: status != "Published"
    sort: publish_date asc
    show:
      - channel
      - status
      - publish_date
      - owner
  - name: All content
    source: content
    view: table
    sort: publish_date desc
    columns:
      - title
      - channel
      - campaign
      - pillar
      - status
      - publish_date
      - owner
      - views
      - clicks
      - ctr
      - draft
height: 620
```
