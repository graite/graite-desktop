# bench-search: quick

1000 pages · 25 queries · 2026-11-17 · target: under 200 ms

| Search | Requests | Median ms | p95 ms | Slowest ms | Median in daemon ms | Used vectors |
|---|---:|---:|---:|---:|---:|---:|
| Words and titles only (no model loaded) | 75 | 1.4 | 2.3 | 32.0 | 1.0 | 0/75 |
| Hybrid, query not seen before | 25 | 14.2 | 27.5 | 29.4 | 13.5 | 25/25 |
| Hybrid, query seen before (cached vector) | 75 | 2.9 | 3.8 | 3.8 | 2.5 | 75/75 |

Embedding 2949 passages took 145 s with `embeddinggemma-300m-q8` on CPU.
A query that was not seen before waits at most 120 ms for its vector; when the vector is later than that, the results are by words and titles and the vector is ready for the next keystroke.

Result: p95 3.8 ms, within the target.
