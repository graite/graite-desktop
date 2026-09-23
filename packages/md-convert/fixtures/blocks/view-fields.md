A board ready for its first task.

```graite:view
settings:
  fields:
    - name: Status
      type: status
      options:
        - Backlog
        - Open
        - In progress
        - Done
    - name: Priority
      type: single_select
      options:
        - High
        - Medium
        - Low
    - name: Project
      type: text
view: kanban
group: Status
show:
  kanban:
    - Priority
    - Project
```
