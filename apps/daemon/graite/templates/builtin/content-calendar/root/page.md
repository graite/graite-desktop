---
title: Content calendar
icon: 📅
---

> [!tip] How it works
> Every piece of **content** has a channel, a status and a publish date; drafts can live on their own page, linked from the row. Group pieces into **campaigns**. After publishing, fill in views, clicks and conversions: Graite computes the click-through and conversion rates.

```graite:dashboard
src: _dashboards/calendar.html
```

```graite:table
views:
  - name: Coming up
    source: content
    view: list
    filter: status != "Published"
    sort: publish_date asc
    show:
      - channel
      - status
      - publish_date
      - owner
height: 320
```

## Databases

[[Content]]

[[Channels]]

[[Campaigns]]

## Guides

[[Draft five spreadsheet mistakes]]
