# Grapim Review benchmark (dev half, used for tuning)

23 PRs (19 with ground-truth problems, 4 clean), 34 ground-truth issues.

| Tool | PRs run | Recall | Precision | F1 | Recall, lines only | Precision, lines only | Comments / PR | Findings on clean PRs (per PR) | Cost / PR | Time / PR (mean, median) |
|---|---|---|---|---|---|---|---|---|---|---|
| grapim-lean-paid | 23 | 52.9% (18/34) | 38.2% (21/55) | 44.4% | 44.1% | 29.1% | 2.4 | 0.5 (2/4 flagged) | $0.142 | 30 s, 25 s |
| grapim-lean | 23 | 55.9% (19/34) | 29.6% (21/71) | 38.7% | 44.1% | 22.5% | 3.1 | 0.3 (1/4 flagged) | $0.171 | 34 s, 32 s |
| grapim-lean-rerun | 23 | 58.8% (20/34) | 31.7% (20/63) | 41.2% | 44.1% | 23.8% | 2.7 | 0.5 (2/4 flagged) | $0.171 | 34 s, 30 s |
| grapim-lean-x2 | 23 | 58.8% (20/34) | 30.1% (25/83) | 39.8% | 44.1% | 20.5% | 3.6 | 0.3 (1/4 flagged) | $0.233 | 66 s, 64 s |
| pr-agent | 23 | 44.1% (15/34) | 33.3% (15/45) | 38.0% | 35.3% | 26.7% | 2.0 | 0.5 (2/4 flagged) | $0.094 | 37 s, 33 s |

## Recall by ground-truth category

| Category | grapim-lean-paid | grapim-lean | grapim-lean-rerun | grapim-lean-x2 | pr-agent |
|---|---|---|---|---|---|
| correctness | 11/21 | 12/21 | 12/21 | 13/21 | 9/21 |
| intent_mismatch | 3/3 | 3/3 | 3/3 | 2/3 | 2/3 |
| other | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 |
| scope | 2/4 | 2/4 | 2/4 | 2/4 | 2/4 |
| security | 2/3 | 2/3 | 2/3 | 2/3 | 2/3 |
| weakened_check | 0/2 | 0/2 | 1/2 | 1/2 | 0/2 |

Recall: ground-truth issues with at least one matching finding. Precision: findings that match some ground-truth issue; every finding on a clean PR counts against it. A finding matches an issue on the same file when its lines are within ±10 lines or its category is the same (categories inferred from the text for tools that give none). The "lines only" columns drop the category rule (it is lenient: most issues are correctness, so any correctness comment on the file counts); issues without a line still match by category there. Cost at claude-opus-5-5 list prices ($4 / $20 per million input / output tokens, cache reads $0.20, cache writes $5), from the API usage the metering proxy saw.
