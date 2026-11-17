# bench-ask: quick, example vault

23 pages · model `gemma-4-E2B-it-Q4_K_M.gguf` · 10 questions · 2026-11-17

| # | Question | Retrieval ms | Pages | Passages | Context tokens | Prompt tokens | Prompt read ms | First token ms | Total ms | Tokens/s | Right page given | Right page cited | Answered |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| 1 | How many people work in the field at Fernhill? | 23 | 4 | 5 | 786 | 2,324 | 28,700 | 40,659 | 41,902 | 35 | yes | yes | yes |
| 2 | Who decides at Fernhill, and what do they care about? | 15 | 5 | 5 | 703 | 2,018 | 16,915 | 27,475 | 28,302 | 37 | yes | yes | yes |
| 3 | What was decided about offline mode versus export in the product sync? | 15 | 3 | 5 | 602 | 1,510 | 11,994 | 18,556 | 18,965 | 38 | yes | yes | yes |
| 4 | By how much did the onboarding changes cut setup time? | 14 | 4 | 5 | 716 | 2,316 | 19,418 | 27,154 | 27,551 | 36 | yes | yes | yes |
| 5 | Who has to estimate the sync conflict screen, and by when? | 15 | 3 | 5 | 625 | 1,563 | 12,254 | 20,706 | 21,331 | 39 | yes | yes | yes |
| 6 | What are the success measures for offline mode? | 13 | 4 | 5 | 617 | 1,518 | 11,884 | 20,327 | 21,739 | 39 | yes | yes | yes |
| 7 | What is out of scope for offline mode? | 13 | 4 | 5 | 617 | 1,518 | 11,899 | 21,735 | 22,730 | 38 | yes | yes | yes |
| 8 | What did the field study find about failed saves? | 14 | 4 | 5 | 663 | 1,841 | 14,903 | 25,023 | 25,819 | 38 | yes | yes | yes |
| 9 | How often do sync conflicts occur according to the logs? | 13 | 4 | 5 | 633 | 1,844 | 15,012 | 23,948 | 25,087 | 37 | yes | yes | yes |
| 10 | What is Fernhill's next step, and who owns it? | 15 | 5 | 5 | 735 | 1,906 | 15,556 | 30,582 | 32,535 | 37 | yes | yes | yes |
| | **Mean** | 15 | 4.0 | 5.0 | 670 | 1,836 | 15,854 | 25,616 | 26,596 | 37.5 | 10/10 | 10/10 | 10/10 |

Context tokens are estimated (four characters to a token); prompt tokens and tokens/s are what the model server reported. "Right page given" means the page that holds the answer was among the passages or tool results of the turn.
