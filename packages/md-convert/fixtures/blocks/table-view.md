# Expenses

```graite:table
source: _data/expenses.csv
```

```graite:table
source: _data/expenses.csv
view: table
filter: category = "Travel" and amount > 100
sort: date desc
columns:
  - date
  - description
  - amount
  - category
height: 480
```

```graite:table
source: People/_data/people.csv
sort:
  - -age
  - name
columns: []
```

```graite:table
source: _data/expenses.csv
tabs:
  _data/people.csv:
    filter: age > 30
    sort:
      - -age
    columns:
      - name
  People/_data/teams.csv:
    sort: name
```

![[expenses.csv]]

Other embeds stay text:

![[diagram.png]]

See ![[notes.csv]] inline.
