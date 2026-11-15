# Grapim Review benchmark (dev half, used for tuning)

23 PRs (19 with ground-truth problems, 4 clean), 34 ground-truth issues.

| Tool | PRs run | Recall | Precision | F1 | Recall, lines only | Precision, lines only | Comments / PR | Findings on clean PRs (per PR) | Cost / PR | Time / PR (mean, median) |
|---|---|---|---|---|---|---|---|---|---|---|
| grapim-noprov | 23 | 17.6% (6/34) | 38.9% (7/18) | 24.3% | 11.8% | 22.2% | 0.8 | 0.0 (0/4 flagged) | $0.154 | 9 s, 6 s |
| pr-agent | 23 | 44.1% (15/34) | 33.3% (15/45) | 38.0% | 35.3% | 26.7% | 2.0 | 0.5 (2/4 flagged) | $0.094 | 37 s, 33 s |

## Recall by ground-truth category

| Category | grapim-noprov | pr-agent |
|---|---|---|
| correctness | 3/21 | 9/21 |
| intent_mismatch | 0/3 | 2/3 |
| other | 0/1 | 0/1 |
| scope | 1/4 | 2/4 |
| security | 2/3 | 2/3 |
| weakened_check | 0/2 | 0/2 |

Recall: ground-truth issues with at least one matching finding. Precision: findings that match some ground-truth issue; every finding on a clean PR counts against it. A finding matches an issue on the same file when its lines are within ±10 lines or its category is the same (categories inferred from the text for tools that give none). The "lines only" columns drop the category rule (it is lenient: most issues are correctness, so any correctness comment on the file counts); issues without a line still match by category there. Cost at claude-opus-5-5 list prices ($4 / $20 per million input / output tokens, cache reads $0.20, cache writes $5), from the API usage the metering proxy saw.
