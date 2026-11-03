# Deals

```graite:table
views:
  - name: Pipeline
    source: _data/deals.csv
    view: board
    group: stage
    filter: stage != "Lost"
    sort: expected_close asc
    show:
      - company
      - value
      - expected_close
    boards:
      order:
        - Lead
        - Qualified
        - Won
      hidden:
        - Lost
  - name: All deals
    source: _data/deals.csv
    view: table
    columns:
      - name
      - stage
      - value
  - name: People
    source: People/_data/contacts.csv
    view: list
    show: []
height: 560
```
