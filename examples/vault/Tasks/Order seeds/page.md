---
id: 018f3c2e-0000-7000-8000-000000000031
title: Order seeds
created: '2026-09-14T00:00:00Z'
updated: '2026-09-14T00:00:00Z'
order: 0
properties:
  - id: status
    name: Status
    type: status
    options: [To do, In progress, Done]
    colors: {To do: gray, In progress: yellow, Done: green}
    value: Done
  - id: priority
    name: Priority
    type: single_select
    options: [High, Medium, Low]
    colors: {High: red, Medium: orange, Low: blue}
    value: High
  - id: due
    name: Due
    type: date
    options: []
    colors: {}
    value: '2026-03-15'
---

Tomatoes, beans and basil. Delivered.
