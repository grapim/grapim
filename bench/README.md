# Grapim Review benchmark

Does Grapim Review (`src/airev/`) find the problems that human reviewers found in pull requests written by AI coding agents, and does it do so with fewer false alarms than the open-source incumbent [PR-Agent](https://github.com/The-PR-Agent/pr-agent) and Anthropic's [Claude Code Action](https://github.com/anthropics/claude-code-action)?

The dataset is real public PRs opened by coding agents (GitHub Copilot coding agent, Devin, Codex, Claude Code, Cursor, Jules). For each, the ground truth is what a human reviewer pointed out and the agent then fixed, or what was reverted. Each tool reviews the PR **as the human saw it** (the head commit before the fix commits), and its comments are matched against that ground truth.

Nothing here writes to GitHub. All GitHub access is read-only (`GET` requests and `git fetch`), cached under `bench/cache/` (gitignored).

## Layout

| Path | What |
|---|---|
| `data/annotations.json` | The hand-written ground truth: PR, reviewed head commit, issues (file, line, category, description, evidence link, confidence). |
| `data/prs.json` | The dataset the harness reads, built from the annotations plus GitHub metadata by `collect.mjs build`. |
| `data/repos.txt` | Active repositories searched for agent PRs. |
| `collect.mjs` | `discover`: finds candidate PRs and writes a review-timeline digest for annotating. `build`: writes `prs.json`. |
| `run.mjs` | Runs the reviewers, saves raw output to `results/<tool>/<owner>__<repo>__<n>.json`. `--estimate`, `--dry`. |
| `score.mjs` | Matches findings to ground truth, writes `results/report.md` and `results/scores.json`. |
| `lib/` | GitHub cache (`gh.mjs`), git plumbing (`git.mjs`), the adapters, the metering proxy, the provenance writer, the scorer. |

## Steps

```sh
# 1. Dataset (already done; reproduces prs.json from the annotations, read-only GitHub calls)
node bench/collect.mjs build
#    To look for more PRs to annotate:
node bench/collect.mjs discover --pages 1 --repos bench/data/repos.txt   # -> bench/cache/digest.md

#    Check that every ground-truth issue points at a file of the reviewed head and
#    at (or within 10 lines of) a line the PR added (fetches git data; no model calls)
node bench/run.mjs --check --concurrency 8

# 2. See what a real run would cost (no model calls; fetches git data from GitHub)
node bench/run.mjs --estimate

# 3. Check the whole pipeline against a local fake model (no network to any model)
node bench/run.mjs --dry --tools grapim,grapim-noprov,pr-agent,claude-action
node bench/score.mjs --dry

# 4. The real run (spends money; refuses without --yes)
ANTHROPIC_API_KEY=sk-ant-... node bench/run.mjs --yes --tools grapim,pr-agent,claude-action
node bench/score.mjs            # -> bench/results/report.md
```

Useful flags for `run.mjs`: `--only <id,id>` (ids as in `prs.json`), `--limit N`, `--concurrency N` (repositories in parallel, default 2), `--force` (re-run PRs that already have an `ok` result), `--verbose`, `--max-turns N` (Claude agent turns, default 60), `--intent-chars N` (prompt length in Grapim's provenance note, default 1000). For `score.mjs`: `--window N` (line tolerance, default 10), `--tools a,b`, `--judge` (LLM judge, off by default, costs calls).

## Estimated cost of one full run (46 PRs, claude-opus-5-5)

From `run.mjs --estimate` (diff sizes measured, chars / 4; output tokens and Claude's agent turns are assumptions listed in `lib/estimate.mjs`):

| Tool | Requests | USD total | USD / PR |
|---|---|---|---|
| grapim | 56 | $6.54 | $0.14 |
| grapim-noprov | 56 | $6.49 | $0.14 |
| pr-agent | 46 | $5.82 | $0.13 |
| claude-action | ~913 turns | $38.84 | $0.84 |

About $58 for all four, $51 without the ablation. The Claude agent's cost is the least certain (turns and file reads vary a lot by PR); budget 2x for it. The `--judge` mode adds roughly one small request per finding that lands on an issue's file.

## Dataset

`data/prs.json` holds 46 PRs from 40 repositories (all public, at least 300 stars): 34 with ground-truth problems (58 issues) and 12 clean.

| Agent | PRs with problems | Issues | Clean PRs |
|---|---|---|---|
| GitHub Copilot coding agent | 13 | 18 | 2 |
| Claude Code | 10 | 17 | 6 |
| Devin | 8 | 19 | 2 |
| Cursor background agent | 3 | 4 | 0 |
| Codex | 0 | 0 | 2 |

Issues by category: correctness 41, scope 7, security 3, weakened_check 3, intent_mismatch 3, other 1. Confidence: 38 high, 20 medium. No Jules PR and no Codex problem PR passed the bar: the candidates had only style comments, bot reviews, or no fix after the comment.

How it was made: `collect.mjs discover` searched GitHub for merged PRs by each agent (app authors `copilot-swe-agent`, `devin-ai-integration`, `cursor`, `google-labs-jules`; PR bodies with "Generated with Claude Code" or a `chatgpt.com/codex` link), in repositories with at least 300 stars and in `data/repos.txt`, and kept the ones where a human review comment was followed by a commit. Each kept issue was annotated by reading the comment, its replies, and the diff of the commit that fixed it; style, naming, docs wording, design preferences, questions without a code change, and reviews by bots were left out. Each issue has a confidence (`high` or `medium`; nothing `low` was kept), the evidence link and the fix commit. Clean PRs are merged, approved by a maintainer, have no human review comments and no commits after review, and no later PR referencing them was found. `run.mjs --check` confirms every issue's file exists at the reviewed head and its line is within 10 lines of a line the PR added (58/58).

Three PRs (apache/airflow#69812, mastra-ai/mastra#15815, latitude-dev/latitude-llm#2697) were force-pushed after review; their reviewed head is no longer in the PR's commit list but is still fetchable by sha.

## Environment

| Variable | For | |
|---|---|---|
| `ANTHROPIC_API_KEY` | all tools, real runs | One key, one model (`claude-opus-5-5`) for every tool. |
| `BENCH_MODEL` | all | Override the model id (default `claude-opus-5-5`). |
| `GRAPIM_REVIEW_PROVIDER` + that provider's variables | grapim | Run Grapim through Bedrock, Vertex or Foundry instead (as `grapim review --ai` does). Its usage then comes from the engine's own counters, not the proxy. |
| `BENCH_PR_AGENT_CMD` | pr-agent | The command that runs PR-Agent's CLI, e.g. `python -m pr_agent.cli` (default: `pr-agent` on PATH). |
| `BENCH_CLAUDE_CMD` | claude-action | Path of the `claude` CLI (default: `claude` on PATH). |
| `BENCH_CLAUDE_TMP` | claude-action | A scratch folder for the agent's shell, if the default temp folder is not writable. |
| `GITHUB_TOKEN` / `GH_TOKEN` | collect, run | Read-only GitHub access; defaults to the `gh` CLI's login. |

The harness removes every `CLAUDE*` / `ANTHROPIC*` variable it inherits before starting PR-Agent or Claude Code, then sets its own, so a host session's base URL or OAuth login never leaks into a tool under test.

## How each tool runs

All model traffic of every tool goes through a local **metering proxy** (`lib/meter-proxy.mjs`) that forwards to `https://api.anthropic.com` and adds up the `usage` of every response (input, cache write, cache read, output tokens), so cost is counted the same way for all three. In `--dry` mode the same proxy answers locally with scripted replies and nothing leaves the machine.

Every tool reviews the same diff: merge base of the PR's target branch to the reviewed head, 3 lines of context.

### `grapim` (and `grapim-noprov`)

`reviewChanges` from `src/airev/index.js` on a bare clone of the PR, with the default `.grapim/review.json` settings and `claude-opus-5-5`, through `anthropicProvider` pointed at the proxy (or `providerFromEnv`, as `grapim review --ai` does, when `GRAPIM_REVIEW_PROVIDER` names another provider).

Grapim's design reviews agent-written lines against the prompt the agent was given, from the provenance notes (`refs/notes/grapim`) a team running Grapim records at commit time. Public PRs have no notes, so the harness writes the note Grapim would have written (`lib/provenance.mjs`): every line the PR's commits added belongs to one agent run, whose prompt is the linked issue's title and body (else the PR title and description), cut at 1000 characters. That is the `grapim` row.

`grapim-noprov` is the ablation: the same PR with no notes and `"review": "all"`, i.e. Grapim as it behaves for a team that has not installed the hooks. It shows how much of the result comes from the provenance.

Both get the pull request's title, description and up to three linked issues as the request (`requestOf` in `lib/adapters.mjs`), the way the Action reads them; PR-Agent gets the same text. (The first run, 2026-11-14, did not pass it to Grapim, and reviewed code without notes at effort low: those results are kept in `results-v2/grapim-old` for comparison.)

`grapim-lean` is `grapim-noprov` on the diff alone: no whole files as context, 10 unchanged lines around each hunk instead of 3. It costs less than half the input; the run shows whether the whole files earn their cost.

`grapim-lean-x2` is `grapim-lean` with the engine's `passes` setting at 2: every request is reviewed twice and the findings are merged (a problem both passes raise is posted once). On the dev half it found 20 of 34 problems where single passes found 18 to 20, with more comments per PR: not a gain you can tell from noise. `grapim-lean-high` (API effort high) and `grapim-lean-focus` (requests of about 12,000 tokens instead of 30,000) are tuning variants; on the dev half neither found more than `grapim-lean`.

## Dev half and held-out half

`data/split.json` splits the 46 PRs in two (ids sorted, even positions `dev`, odd positions `test`). The reviewer's prompt and settings are tuned only by reading the dev half; nobody reads the issues or outputs of the test half while tuning. `--split dev` or `--split test` on `run.mjs` and `score.mjs` picks a half, and the report says which. Quote the held-out score: the dev score is flattered by the tuning.

### Tuning runs without API spend (`--via-cli`)

`node bench/run.mjs --via-cli --tools grapim-lean --split dev` sends each review request through the Claude Code CLI (`claude -p`: the same model, system prompt, effort and JSON schema, no tools), so it is billed to the Claude plan the shell is signed in to and not to an API key. It runs the Grapim variants only, one PR at a time, and writes to `bench/results-cli`, never next to the API-metered results. Use it to compare settings on the dev half; published numbers come from the API runs. The shell must be one where `claude auth status` says `loggedIn` (the Claude desktop app's Terminal panel is). Checked against the paid run: the same PR gave the same finding on the same line, and over the dev half the same setting found 19 and 20 of 34 problems through the CLI and 18 through the API, with more comments per PR through the CLI (2.7 to 3.1 against 2.4), so compare CLI runs with CLI runs.

Repeated runs of one setting differ: of the 34 dev problems 12 were found by all five runs made on 2026-11-15, 11 by none and 11 by some. A difference of one or two problems between two settings is noise.

### `pr-agent`

PR-Agent's own CLI in **plain-diff mode**, which reviews a unified diff file and writes the structured review to a JSON file, with no GitHub access:

```sh
pr-agent --diff-file=pr.diff --json-output=review.json review \
  --plain_diff.title="<PR title>" --plain_diff.description="<PR body + linked issue>"
```

(`python -m pr_agent.cli` works the same.) The model and keys are set through PR-Agent's environment overrides: `CONFIG__MODEL=anthropic/claude-opus-5-5`, `ANTHROPIC__KEY`, `ANTHROPIC_API_BASE` (the proxy), `CONFIG__CUSTOM_MODEL_MAX_TOKENS=200000` (PR-Agent refuses models missing from its token table otherwise), `CONFIG__NO_TEMPERATURE_MODELS` (Opus 5.5 returns 400 for `temperature`), and `CONFIG__ENABLE_CLAUDE_ADAPTIVE_THINKING=true`. The findings are the review's `key_issues_to_review` (file, start and end line, header, content) plus `security_concerns` when it is not "No".

Install (not done by the harness): `python -m pip install pr-agent` (Python 3.12+), then check the model setup once with `pr-agent doctor` using the same environment. If a PR-Agent release renames any of these settings, `run.mjs --dry --tools pr-agent` fails with PR-Agent's own message. The `--dry` run in this repo skipped PR-Agent because it is not installed here.

Not covered: PR-Agent's `/improve` code suggestions (a separate command and model call). They are mostly refactors, not defects; add `improve` to the adapter if you want them counted.

### `claude-action`

The review prompt of claude-code-action's comprehensive PR review example (`examples/pr-review-comprehensive.yml`), verbatim except for the REPO and PR NUMBER values, run with the Claude Code CLI headless in a checkout of the reviewed head:

```sh
claude -p "<prompt>" --model claude-opus-5-5 --output-format stream-json --verbose \
  --mcp-config mcp.json --strict-mcp-config --max-turns 60 \
  --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*),Read,Glob,Grep,LS"
```

- `gh` on the agent's PATH is a shim (`lib/gh-shim.mjs`) that answers `gh pr diff` and `gh pr view` from the snapshot of the PR at the reviewed head (on GitHub they would show the PR as it is today, after the fixes) and records `gh pr comment`. Every other `gh` command is refused.
- `github_inline_comment` is a stand-in for the action's MCP server (`lib/inline-comment-mcp.mjs`): the same tool name and parameters, recording instead of posting.
- The findings are the agent's `create_inline_comment` calls, read from the stream-json events (calls with `confirmed: false`, which the action never posts, and LEFT-side comments are dropped). Top-level PR comments are kept in the raw result but not scored.
- `ANTHROPIC_MODEL` and the small/fast model are both `claude-opus-5-5`.

Run it from a normal terminal. Started from inside another Claude Code session (as when this benchmark was built), the nested agent's shell could not create its temp folder (EPERM), so its `Bash(gh pr diff)` call failed; the `--dry` run then fell back to commenting on a known changed line. Set `BENCH_CLAUDE_TMP` if your temp folder is not writable. The checkout is a full checkout of the reviewed head (file contents downloaded), which for large repositories (dotnet/runtime, elastic/kibana, microsoft/vscode) is several hundred MB each.

Differences from the hosted action: no GitHub context the action adds on its own (repository instructions file loading is the CLI's normal behaviour, so a `CLAUDE.md` in the PR's repo is read as it would be in the action), no progress tracking comment, and no post-run classification of buffered comments (all calls not marked `confirmed: false` count).

## Scoring

`score.mjs` matches each finding to the ground-truth issues of its PR:

- **match**: same file (paths compared after stripping `a/`, `b/`, `./`, or on a `/` boundary) and either the line ranges are within ±10 lines, or the finding's category equals the issue's. Tools that give no category (PR-Agent, the Claude action) get one inferred from the finding's text with the same keyword rules for everyone (`inferCategory` in `lib/score-lib.mjs`).
- **lines only** (extra columns): the same without the category rule, for issues that have a line. The category rule is lenient (41 of 58 issues are correctness, so any comment inferred as correctness on that file counts: the dry run's fake one-comment-per-file reviewer scores 28% recall with it and 14% without). Quote both.
- **recall**: ground-truth issues with at least one matching finding / all issues on the PRs the tool ran on.
- **precision**: findings that match some issue / all findings. Every finding on a clean PR counts against precision.
- **comments per PR**, **findings on clean PRs**, **cost per PR** (claude-opus-5-5 list prices: $4 / $20 per million input / output tokens, cache reads $0.20, cache writes $5, from the proxy's usage counts), **time per PR** (wall clock of the tool).
- `--judge` (off by default): asks claude-opus-5-5 whether each finding on the same file as an issue describes the same defect, and uses that verdict for those pairs. Answers are cached in `bench/cache/judge/`.

## Threats to fairness and known limitations

- **Precision is a lower bound for every tool.** A finding that is a real problem the human reviewer did not raise counts as a false positive. The ground truth lists what humans caught, not every bug. Read the clean-PR column and spot-check findings before quoting precision.
- **Ground truth is one annotator's reading** of review comments and fix commits. Each issue carries a confidence; `prs.json` keeps the evidence link so anyone can check it. Comments about style, naming or design preference were not taken as issues.
- **Provenance is synthetic.** The `grapim` row uses notes the harness wrote, with the linked issue as the agent's prompt. Real notes hold the first line of each prompt (140 characters) per turn; ours hold up to 1000 characters of the request. PR-Agent gets the same request text (title, description and linked issue), and the Claude agent can read the PR description with `gh pr view`. `grapim-noprov` shows the result without it.
- **Same model, different harnesses.** All three use claude-opus-5-5 with adaptive thinking, but each tool picks its own effort and context. Claude Code also loads its own system prompt and tools; PR-Agent may compress large diffs to fit its token budget.
- **The Claude action is approximated**: same prompt and tools, local stand-ins for `gh` and the inline-comment server, no buffered-comment classifier. Its results could differ slightly from the hosted action.
- **PR-Agent runs in plain-diff mode**, which has no repository context beyond the diff (its GitHub mode also works from the diff, plus extra lines around hunks).
- **Line drift**: issue lines are on the reviewed head; a tool comments on the same head, so lines agree. Issues about deleted files or whole-file problems have no line and match by file and category.
- **Time per PR includes some git download time.** The clones are shallow, blob-less partial clones (a full clone of dotnet/runtime or elastic/kibana is gigabytes). Before each PR the harness prefetches, in batches and outside the timed section, the file versions of the PR's diff and of each PR commit, but Grapim's `git blame` (it attributes lines to commits) can still pull older file versions one at a time on large repositories. Compare times on the median, or run twice (the second run has the objects locally).
- **Non-determinism**: one run per tool per PR. Re-run with `--force` and compare before treating small differences as real.
- **Selection bias**: PRs come from GitHub search over repositories with at least 300 stars and from `data/repos.txt`; PRs with visible review back-and-forth are over-represented among problem PRs.
- **The other engineer's edits**: `src/airev/` may change while the benchmark runs; record the commit (`git rev-parse HEAD`) with every reported result.

## Martian's offline Code Review Bench

[Code Review Bench](https://github.com/withmartian/code-review-benchmark) (Martian, MIT) is an independent benchmark: 50 pull requests from Sentry, Grafana, Cal.com, Discourse and Keycloak with 173 golden comments (text, no file or line), an LLM judge, and the raw reviews of 49 tools published next to their scores. `martian-build.mjs`, `run.mjs --data` and `martian.mjs` run Grapim on the same pull requests and judge it and the published tools with one judge.

```bash
# 1. The benchmark's data (not in this repo): put these two files in bench/cache/martian/
#    benchmark_data.json        from offline/results/benchmark_data.json
#    evaluations-opus-4-5.json  from offline/results/anthropic_claude-opus-4-5-20251101/evaluations.json
# 2. The dataset in this harness's format (reads each PR's base and head from GitHub)
node bench/martian-build.mjs
# 3. Review the 50 PRs (here on a Claude plan; drop --via-cli and add --yes for the API)
node bench/run.mjs --via-cli --tools grapim-lean --data bench/data/martian.json --results bench/results-martian
# 4. Judge Grapim, and the published tools' own candidates, with the same judge
node bench/martian.mjs judge --tool grapim-lean
node bench/martian.mjs judge --published coderabbit,kodus-v2,claude-code,qodo-v2,macroscope,bugbot
# 5. The table
node bench/martian.mjs score      # -> bench/results-martian/report-martian.md
```

How the pieces work:

- **The pull requests.** Every benchmark PR was opened once per tool in a public fork (`code-review-benchmark/<repo>__<tool>__PR<n>__<date>`). `martian-build.mjs` reads base and head from the CodeRabbit fork at the pull request number the data names, takes the merge base as the base (the fork's main branch is often ahead of where the PR starts; one was 2,882 commits ahead), and checks each PR against the files that tool's comments are on. Two earlier attempts were wrong and their results were thrown away: PR #1 of another tool's fork is sometimes a different pull request, and diffing against the fork's main reviews changes the PR never made.
- **The judge.** The benchmark's own prompt ("does the candidate identify the same underlying issue as the golden comment?"), asked once per PR for all pairs instead of pair by pair, with `claude-opus-5-5` (`BENCH_JUDGE_MODEL`). A Grapim candidate is one posted finding. A published tool's candidates are the ones in Martian's evaluation file (93 to 98% of them can be rebuilt from it; the missing ones had matched a golden comment, so they change neither recall nor the false-positive count). Scores use the benchmark's default "core" profile.
- **How far our judge is from theirs.** On the same candidates: CodeRabbit 41.1 F1 with our judge, 42.2 published; Kodus v2 45.1 and 46.7; Claude Code 43.2 and 47.2; Bugbot 50.2 and 51.4; Macroscope 48.4 and 54.2. Ours is a little stricter, so compare rows judged the same way.

Results of 2026-11-15, `grapim-lean` (the setting Cloud review ships: every change reviewed, the diff with 10 lines of context, Opus 5.5), never tuned on these pull requests, three runs:

| Tool | Precision | Recall | F1 | Comments / PR |
|---|---|---|---|---|
| Qodo v2 (Feb 2026) | 54.1% | 58.9% | 56.4 | 3.5 |
| **Grapim, mean of 3 runs** | 48.3% | 55.9% | **51.8** (52.6, 52.1, 50.6) | 3.8 |
| Cursor Bugbot (Jan 2026) | 56.8% | 44.9% | 50.2 | 2.5 |
| Macroscope (Mar 2026) | 56.3% | 42.4% | 48.4 | 2.4 |
| Kodus v2 (Mar 2026) | 58.6% | 36.7% | 45.1 | 2.0 |
| Claude Code (Mar 2026) | 44.1% | 42.4% | 43.2 | 3.2 |
| CodeRabbit (Jan 2026) | 32.1% | 57.0% | 41.1 | 5.9 |

What to say with these numbers, and what not:

- The other tools' reviews are the ones Martian published, made between January and March 2026 with the models of that time. Their current versions may score differently; the benchmark has no newer runs of them.
- The pull requests and golden comments are public, so a newer model may have seen them in training. Grapim's run used a model released after them.
- The golden comments are incomplete: a real problem that is not among them counts as a false positive, for every tool.
- Fifty pull requests. Three runs of the same Grapim setting spread over 2 F1 points, so Bugbot and Grapim are level; the gaps to Kodus v2, Claude Code and CodeRabbit are several times that.
- Grapim was run through the Claude Code CLI (`--via-cli`), which posts a few more comments than the API path. A published claim should come from an API run.
- CodeRabbit's terms of service bar its customers from disclosing benchmark results. These numbers use reviews a third party published, not a run of ours; get advice before publishing them.
- Martian's own leaderboard lists only tools with roughly 600 to 1,000 reviewed public pull requests and an attributable bot identity. Its monthly online tracker (which pull requests developers changed after a bot's review) is a different measure from this fixed set, and the two scores cannot be compared.
