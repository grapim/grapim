# Grapim Review benchmark

46 PRs (34 with ground-truth problems, 12 clean), 58 ground-truth issues.

| Tool | PRs run | Recall | Precision | F1 | Recall, lines only | Precision, lines only | Comments / PR | Findings on clean PRs (per PR) | Cost / PR | Time / PR (mean, median) |
|---|---|---|---|---|---|---|---|---|---|---|
| grapim-noprov | 46 | 20.7% (12/58) | 40.0% (12/30) | 27.3% | 15.5% | 30.0% | 0.7 | 0.0 (0/12 flagged) | $0.113 | 7 s, 4 s |
| pr-agent | 46 | 50.0% (29/58) | 38.2% (29/76) | 43.3% | 43.1% | 34.2% | 1.7 | 0.8 (6/12 flagged) | $0.080 | 38 s, 30 s |

## Recall by ground-truth category

| Category | grapim-noprov | pr-agent |
|---|---|---|
| correctness | 9/41 | 21/41 |
| intent_mismatch | 0/3 | 2/3 |
| other | 0/1 | 0/1 |
| scope | 1/7 | 3/7 |
| security | 2/3 | 2/3 |
| weakened_check | 0/3 | 1/3 |

Recall: ground-truth issues with at least one matching finding. Precision: findings that match some ground-truth issue; every finding on a clean PR counts against it. A finding matches an issue on the same file when its lines are within ±10 lines or its category is the same (categories inferred from the text for tools that give none). The "lines only" columns drop the category rule (it is lenient: most issues are correctness, so any correctness comment on the file counts); issues without a line still match by category there. Cost at claude-opus-5-5 list prices ($4 / $20 per million input / output tokens, cache reads $0.20, cache writes $5), from the API usage the metering proxy saw.
