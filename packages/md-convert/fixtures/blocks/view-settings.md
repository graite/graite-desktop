```graite:view
settings:
  boards:
    Status:
      order:
        - Done
        - To do
        - ""
      hidden:
        - ""
  sort:
    field: Estimate
    direction: desc
  filters:
    - field: Priority
      op: equals
      value: High
view: kanban
group: Status
show:
  kanban:
    - Estimate
    - Priority
```
