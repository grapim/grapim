# Martian offline Code Review Bench: 50 PRs, 173 golden comments

Scored on the 50 PRs that have a verdict for every tool listed.

Judge for the "our judge" rows: claude-opus-5-5, one request per PR. "published" rows: Martian's own verdicts (judge claude-opus-4-5, pair by pair).

## Core profile (the benchmark default)

| Tool | Verdicts | PRs | Candidates / PR | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| grapim-lean | our judge | 50 | 3.9 | 48.4% (91/188) | 57.6% (91/158) | 52.6% |
| grapim-lean-r2 | our judge | 50 | 3.4 | 50.6% (85/168) | 53.8% (85/158) | 52.1% |
| grapim-lean-r3 | our judge | 50 | 3.9 | 45.9% (89/194) | 56.3% (89/158) | 50.6% |
| grapim-lean-sl | our judge | 50 | 3.2 | 52.5% (84/160) | 53.2% (84/158) | 52.8% |
| bugbot | our judge | 50 | 2.5 | 56.8% (71/125) | 44.9% (71/158) | 50.2% |
| bugbot | published | 50 | 2.6 | 56.9% (74/130) | 46.8% (74/158) | 51.4% |
| claude-code | our judge | 50 | 3.2 | 44.1% (67/152) | 42.4% (67/158) | 43.2% |
| claude-code | published | 50 | 3.5 | 46.3% (76/164) | 48.1% (76/158) | 47.2% |
| coderabbit | our judge | 50 | 5.9 | 32.1% (90/280) | 57.0% (90/158) | 41.1% |
| coderabbit | published | 50 | 6.4 | 32.6% (94/288) | 59.5% (94/158) | 42.2% |
| kodus-v2 | our judge | 50 | 2.0 | 58.6% (58/99) | 36.7% (58/158) | 45.1% |
| kodus-v2 | published | 50 | 2.1 | 59.2% (61/103) | 38.6% (61/158) | 46.7% |
| macroscope | our judge | 50 | 2.4 | 56.3% (67/119) | 42.4% (67/158) | 48.4% |
| macroscope | published | 50 | 2.6 | 61.1% (77/126) | 48.7% (77/158) | 54.2% |
| qodo-v2 | our judge | 50 | 3.5 | 54.1% (93/172) | 58.9% (93/158) | 56.4% |
| qodo-v2 | published | 50 | 3.5 | 55.4% (98/177) | 62.0% (98/158) | 58.5% |

## All categories

| Tool | Verdicts | PRs | Candidates / PR | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| grapim-lean | our judge | 50 | 3.9 | 50.0% (97/194) | 56.1% (97/173) | 52.9% |
| grapim-lean-r2 | our judge | 50 | 3.4 | 51.7% (89/172) | 51.4% (89/173) | 51.6% |
| grapim-lean-r3 | our judge | 50 | 3.9 | 47.2% (94/199) | 54.3% (94/173) | 50.5% |
| grapim-lean-sl | our judge | 50 | 3.2 | 53.7% (88/164) | 50.9% (88/173) | 52.2% |
| bugbot | our judge | 50 | 2.5 | 57.8% (74/128) | 42.8% (74/173) | 49.2% |
| bugbot | published | 50 | 2.6 | 58.2% (78/134) | 45.1% (78/173) | 50.8% |
| claude-code | our judge | 50 | 3.2 | 46.2% (73/158) | 42.2% (73/173) | 44.1% |
| claude-code | published | 50 | 3.5 | 48.8% (84/172) | 48.6% (84/173) | 48.7% |
| coderabbit | our judge | 50 | 5.9 | 34.3% (99/289) | 57.2% (99/173) | 42.9% |
| coderabbit | published | 50 | 6.4 | 34.7% (103/297) | 59.5% (103/173) | 43.8% |
| kodus-v2 | our judge | 50 | 2.0 | 59.4% (60/101) | 34.7% (60/173) | 43.8% |
| kodus-v2 | published | 50 | 2.1 | 59.6% (62/104) | 35.8% (62/173) | 44.8% |
| macroscope | our judge | 50 | 2.4 | 57.4% (70/122) | 40.5% (70/173) | 47.5% |
| macroscope | published | 50 | 2.6 | 62.3% (81/130) | 46.8% (81/173) | 53.5% |
| qodo-v2 | our judge | 50 | 3.5 | 55.1% (97/176) | 56.1% (97/173) | 55.6% |
| qodo-v2 | published | 50 | 3.5 | 56.4% (102/181) | 59.0% (102/173) | 57.6% |
