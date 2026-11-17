# bench-ask: baseline, example vault

23 pages · model `gemma-4-E2B-it-Q4_K_M.gguf` · 10 questions · 2026-11-17

| # | Question | Retrieval ms | Pages | Passages | Context tokens | Prompt tokens | Prompt read ms | First token ms | Total ms | Tokens/s | Right page given | Right page cited | Answered |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| 1 | How many people work in the field at Fernhill? | 22 | 13 | 14 | 1,647 | 6,881 | 69,106 | 73,787 | 74,534 | 28 | yes | yes | yes |
| 2 | Who decides at Fernhill, and what do they care about? | 15 | 12 | 14 | 1,644 | 6,819 | 70,958 | 80,646 | 81,634 | 28 | yes | yes | yes |
| 3 | What was decided about offline mode versus export in the product sync? | 15 | 12 | 14 | 1,651 | 6,886 | 70,476 | 84,453 | 85,298 | 28 | yes | yes | no |
| 4 | By how much did the onboarding changes cut setup time? | 14 | 12 | 14 | 1,623 | 6,804 | 79,799 | 86,994 | 87,577 | 28 | yes | yes | yes |
| 5 | Who has to estimate the sync conflict screen, and by when? | 17 | 11 | 13 | 1,652 | 6,855 | 73,061 | 94,333 | 95,326 | 26 | yes | yes | yes |
| 6 | What are the success measures for offline mode? | 13 | 14 | 16 | 1,643 | 6,882 | 70,883 | 84,464 | 86,524 | 27 | yes | yes | yes |
| 7 | What is out of scope for offline mode? | 13 | 14 | 16 | 1,572 | 6,815 | 71,143 | 79,880 | 81,360 | 26 | yes | yes | yes |
| 8 | What did the field study find about failed saves? | 17 | 13 | 15 | 1,628 | 6,783 | 74,292 | 82,460 | 83,564 | 26 | yes | yes | yes |
| 9 | How often do sync conflicts occur according to the logs? | 15 | 13 | 15 | 1,634 | 6,838 | 70,725 | 87,314 | 88,075 | 27 | yes | yes | yes |
| 10 | What is Fernhill's next step, and who owns it? | 16 | 12 | 13 | 1,651 | 6,888 | 75,836 | 88,974 | 91,134 | 26 | yes | yes | yes |
| | **Mean** | 16 | 12.6 | 14.4 | 1,634 | 6,845 | 72,628 | 84,330 | 85,503 | 27.0 | 10/10 | 10/10 | 9/10 |

Context tokens are estimated (four characters to a token); prompt tokens and tokens/s are what the model server reported. "Right page given" means the page that holds the answer was among the passages or tool results of the turn.
