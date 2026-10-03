# Charts

```graite:chart
source: _data/cars.csv
x: brand
```

```graite:chart
title: Spend per month
source: _data/expenses.csv
type: line
x: month(date)
y:
  - sum(amount)
  - count
filter: amount > 10
sort: x asc
limit: 24
stacked: true
height: 320
palette: sunset
```

```graite:chart
sql: SELECT brand, count(*) FROM cars GROUP BY brand
type: pie
```

```graite:dashboard
src: _dashboards/overview.html
height: 900
```
