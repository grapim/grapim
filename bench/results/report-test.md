# Grapim Review benchmark (held-out half)

23 PRs (15 with ground-truth problems, 8 clean), 24 ground-truth issues.

| Tool | PRs run | Recall | Precision | F1 | Recall, lines only | Precision, lines only | Comments / PR | Findings on clean PRs (per PR) | Cost / PR | Time / PR (mean, median) |
|---|---|---|---|---|---|---|---|---|---|---|
| grapim-noprov | 23 | 25.0% (6/24) | 41.7% (5/12) | 31.3% | 20.8% | 41.7% | 0.5 | 0.0 (0/8 flagged) | $0.072 | 5 s, 4 s |
| pr-agent | 23 | 58.3% (14/24) | 45.2% (14/31) | 50.9% | 54.2% | 45.2% | 1.3 | 0.9 (4/8 flagged) | $0.067 | 39 s, 28 s |

## Recall by ground-truth category

| Category | grapim-noprov | pr-agent |
|---|---|---|
| correctness | 6/20 | 12/20 |
| scope | 0/3 | 1/3 |
| weakened_check | 0/1 | 1/1 |

Recall: ground-truth issues with at least one matching finding. Precision: findings that match some ground-truth issue; every finding on a clean PR counts against it. A finding matches an issue on the same file when its lines are within ±10 lines or its category is the same (categories inferred from the text for tools that give none). The "lines only" columns drop the category rule (it is lenient: most issues are correctness, so any correctness comment on the file counts); issues without a line still match by category there. Cost at claude-opus-5-5 list prices ($4 / $20 per million input / output tokens, cache reads $0.20, cache writes $5), from the API usage the metering proxy saw.
