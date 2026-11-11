# AI code provenance: contract v0

Positioning: **the record of where every line of AI-written code came from.** It covers which agent run wrote it, from which prompt, whether a person reviewed it, and whether it can be undone. It must hold after commit, after push and in the pull request, for every team using AI coding agents, including teams that run a single agent.

This is shared by three builders: provenance (client plus hub ingest), GitHub integration (the Action and the App), and reports. Change it only by editing this file and saying so.

## 1. The note format (git notes)

- **Ref**: `refs/notes/grapim`. There is one note per commit Grapim recorded (every non-merge commit made after `grapim init`): with ranges when agents wrote lines, empty otherwise (see below).
- **Note body**: compact JSON on one line, at most 256 KB; past that, keep only the ranges and drop the intents (if it is still over, whole files are dropped, largest first, and the note carries `"truncated": true`):
```json
{ "v": 1, "tool": "grapim/0.1.0",
  "runs": [ { "id": "claude-code:1a2b…", "label": "claude 1a2b3c4d", "kind": "claude-code|codex|cursor|mcp|http|sync|undo|restore",
              "turns": [ { "turn": 2, "intent": "first line of the prompt (≤140 chars)" } ],
              "review": "pending|approved|rejected" } ],
  "files": { "src/app.ts": [ [12, 30, 0, 2], [41, 41, 0, 2] ] } }
```
- **File entries**: `files[path]` is a list of `[startLine, endLine, runIndex, turn]`, inclusive and 1-based, giving line numbers in that file **as committed in this commit**. Only lines this commit added or changed that the ledger attributes to an agent run are listed. Every other added line is "human or unknown".
- **Kind**: the agent kind is derived from the run id prefix (`claude-code:` gives claude-code; `mcp:` or clientInfo naming codex or cursor gives that tool; `http:` gives http; `sync-` gives sync).
  - *Changed by provenance:* exactly, in order: `claude-code:` → claude-code; `undo:` → undo; `restore:` → restore; `sync-` or `http:sync-` (folder sync through a workspace) → sync; any other `http:` → http; anything else is an MCP run (`<clientInfo name>:<pid>`, `mcp:<pid>` or `$GRAPIM_AGENT`): codex or cursor when the part before the first `:` contains that word, else mcp. Runs named `human:<user>` (the CLI acting as a person) are never listed. Implemented as `kindOf` in `src/provenance/note.js`.
- **Overlapping ranges** (*changed by the security review*): readers resolve them by range boundaries, never line by line, and the first claim wins inside one note too; `parseNote` returns sorted, disjoint ranges.
- **Several notes in one body** (*added by provenance*): git can concatenate notes (`notes.rewriteMode=concatenate` when a rebase squashes commits, `git notes merge`), so a body may hold several notes, one per line. Readers merge them: runs are united by id, and on a line two notes both claim, the first note wins. `parseNote` in `src/provenance/note.js` does this and validates; the hub stores the merged, re-serialised note.
- **Privacy**: intents are prompt first lines. `grapim init --no-intents` (repo config `grapim.notes.intents=false`) writes notes without intents.
- **Commit block (optional, added for reports, section 7)**: `"commit": { "ts": <committer time, epoch ms>, "added": <every line this commit added, all text files, as git diff --numstat against the first parent>, "default_branch": true|false }`. Readers must work without it, and without any one of its keys:
  - without `ts` a report dates the commit by when the hub received the note;
  - without `added` the commit's AI lines are counted, but the commit is left out of the AI share (its total is unknown);
  - `default_branch` is set only when known (for example by `grapim sync` or the Action for commits reachable from the remote's default branch); absent means unknown.
- **Commit block, as the provenance client writes it**: `ts` and `added` on every note it writes, empty notes included, so reports always have a denominator; never `default_branch`.
- **Notes for commits without agent lines (required, decided by the coordinator)**: `record` writes `{ "v": 1, "tool": …, "runs": [], "files": {}, "commit": { "ts": …, "added": … } }` for a commit with no agent lines. Readers tell three states apart:
  - **recorded, human**: an empty note (`runs: []`); its `added` lines are human or unknown and count in the denominator;
  - **AI**: a note with ranges;
  - **unknown, not recorded**: no note at all (commits from before `grapim init`, from machines without the hooks, merge commits). Reports leave these out of the AI share instead of counting them as human.
  - An empty note never replaces a note that lists agent runs, and recording never deletes a note.

## 2. Recording (local)

- `grapim init` also installs git hooks in the repo's hooks dir:
  - `post-commit` runs `grapim provenance record HEAD --hook` (*`--hook` added by provenance*):
    - during a rebase it records nothing, because `notes.rewriteRef` copies each original note when the rebase ends;
    - after `commit --amend`, git copies the old commit's note to the new one after the hook and would concatenate it with a fresh note, so when the old commit has a note the fresh note is written on the old commit and git's copy carries it over;
  - `pre-push` runs `grapim provenance push <remote>`, which also pushes `refs/notes/grapim` and never blocks the push on failure.
  - The hooks chain to any existing hook (they keep the old one as `<name>.grapim-prev` and call it).
  - *Details (provenance)*: the hooks are POSIX sh calling `node "<abs bin>"`, written to the dir `git rev-parse --git-path hooks` names (so `core.hooksPath` is respected) and marked `# grapim-hook v1`. A second `init` rewrites them in place; a `.grapim-prev` already there is kept under a dated name, never lost. The previous hook runs first: its exit status is passed on (a failing pre-push hook of the user's still blocks the push), Grapim's own step never fails the commit or push and prints one line if it fails. The notes push uses `--no-verify` (no hook recursion), no credential prompts and a 30 s timeout; if the remote's notes moved on, they are fetched and merged with `cat_sort_uniq`, then pushed again. `notes.rewriteRef` is added with `--add` only when missing, so other notes refs stay.
  - *SessionStart (provenance)*: the Claude Code plugin cannot install git hooks, so in a git repo without them the hook adds one line of context saying `grapim init` turns commit provenance on (`GRAPIM_NO_INIT_HINT=1` silences it). Nothing is installed from the plugin.
  - `init` also sets `notes.rewriteRef=refs/notes/grapim` and `notes.rewrite.amend/rebase=true` in the repo's local config, so notes survive `--amend` and rebase.
- **`grapim provenance record <commit>`**: for each file the commit changed, the base is the parent's version and the final is the commit's version. Replay the ledger changes recorded for that file since the base (attribution.js has the replay engine; generalise it to take any base content) and attribute the lines added or changed in the commit. It is idempotent: it rewrites the note.
  - *How (provenance)*: `replay(changes, now, { base, key: ignoreEol })` in `src/attribution.js` (no options: unchanged). The replay starts at the latest point where the ledger's content of the file equalled the base, else at the first change, from the base. Only ledger changes up to the commit's committer time (+1 s) count. Lines are compared ignoring line endings, as blame does (with `core.autocrlf` the blob has LF, the ledger CRLF).
  - **New files**: the base is empty. **Deleted files**: nothing added, skipped. **Renames and copies** (`git diff-tree -M`): the base is the old path's version in the parent, and the ledger changes of the old and new paths are replayed together in order. **Binary** (a NUL in the first 8 KB) and files over 2 MB: skipped.
  - **Merge commits are skipped** (no note). Their lines come from the merged commits, which have their own notes, and `git blame` (blame `--history`, the PR summary) attributes each line to the commit that introduced it. An agent's conflict resolution inside a merge commit is therefore not recorded.
  - A commit with no agent lines gets an empty note (section 1). If the commit already has a note that lists agent runs, it is kept: an empty result may only mean this machine lacks the ledger. Recording never deletes a note.
- **`grapim provenance show <commit>`** prints the note, human-readable or with `--json`.
- **`grapim blame <file> --history`** combines `git blame --porcelain` with the notes, so every line of the file, committed or not, gets its agent run, turn and prompt, or "human/unknown". Uncommitted lines still come from the live ledger, as today.
- **`grapim provenance stats [<rev-range>]`** gives the AI-line share per agent and per file, in text and with `--json`.

## 3. Hub ingest

- `grapim sync` also uploads the notes for commits it hasn't uploaded before: `provenance: [{ commit, note }]` in the existing sync batch, capped at 200 per batch.
  - *Details (provenance)*: also at most about 1 MB of notes per batch. The client remembers, in its sync cursor state (`hub-sync.json`, `notes: { base, target, after }`), the notes-ref commit whose notes are all sent, and sends the notes added or changed since then (`git ls-tree` of both). When the hub answers 409 (it has less), the notes are sent again too. Concatenated notes are merged before sending.
  - The hub validates each item: `commit` is 40 lowercase hex, at most once per batch; `note` is at most 256 KB and passes `parseNote`. A bad item refuses the whole batch (400; 413 past 200 items or 256 KB). Notes are upserted (a re-recorded note replaces the stored one) and their bytes count toward the team's storage quota.
- **Hub table** `h_provenance(team_id, repo_id, commit_sha, note_json, received_at)`, primary key (team_id, repo_id, commit_sha).
- **Read helper** for the App and reports: `provenanceFor(team, repo, commitShas[])`.
  - *As built*: `provenanceFor(db, team, repoId, shas)` in `src/hub/provenance.js` (also exported from `src/hub/read.js`) and `hub.read.provenanceFor(team, repoId, shas)`. `team` is the team object or its id. Returns `{ [sha]: note }` with parsed notes, only for that team's rows; commits without a note and strings that are not shas are left out; at most 5000 shas per call.
- **Repo mapping**: link the hub repo id (root commit sha) to GitHub `owner/name` through the client sending its `origin` remote URL, normalised to `github.com/owner/name`, at most one per repo.
  - *As built*: the batch's `repo` object carries `github: "github.com/owner/name"` (only github.com remotes; user, token and `.git` stripped on the client). The hub stores `owner/name` in `repos.github` (the newest sync wins). `repoByGitHub(db, team, "owner/name")` and `hub.read.repoByGitHub(team, fullName)` return the team's matching repos `[{ id, name, github }]`, case-insensitive.

## 4. The PR summary (both the Action and the App render the same thing)

- **Attribution**: for each file the PR changes, take the lines added in the PR's final diff. Find which commit introduced each one (`git blame` locally in the Action, GitHub GraphQL `blame` in the App), then look up that commit's note.
- **Comment**: one comment, updated in place and found by the marker `<!-- grapim:provenance -->`:
  - a headline such as "**62% of the added lines were written by AI agents** (318 of 512): claude 1a2b… 280, codex 4121 38";
  - a table per agent run: lines, files, the prompt (intent) and the review status in Grapim;
  - a list of "Not reviewed in Grapim" runs;
  - a collapsed per-file breakdown.
- **Check run** (the App only), named "Grapim provenance (app)" (*renamed by the security review, M6: a unique name that a branch rule pins to the App*). It is neutral by default. Under a team policy of `require_review` it is success or failure, never neutral; see section 6, "Require review".
- *The Action's comment is informational only and never a merge gate: the Action posts no check run.*
- **Shared renderer** `src/provenance/render.js`: `renderSummary({ files, notesByCommit, blameByFile, reviews }) → { markdown, stats }`. It has no I/O, so the Action, the App and the CLI (`grapim provenance pr <base>..<head>`) all use it.

## 5. The GitHub Action (`action/`)

- `action/action.yml` uses `node20`, and `action/index.mjs` is self-contained with zero dependencies. It may import `../src/provenance/*` only if the files are bundled into `action/dist/`; provide a small bundling script that copies them.
- **Steps**:
  - fetch `refs/notes/grapim` and enough history (`fetch-depth: 0`, or an explicit fetch of the base);
  - compute the summary with `git blame` on the PR head;
  - create or update the comment through the REST API with `GITHUB_TOKEN`.
- **Permissions**: `pull-requests: write` and `contents: read`. Forked PRs (read-only token) print the summary to the job log instead of failing.
- **Example**: `action/README.md` with a workflow example.

## 6. The GitHub App (in the hub, `src/hub/github/`)

- **Env**: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, which can be base64), `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`.
- **Webhook**: `POST /hub/github/webhook`. Verify `X-Hub-Signature-256` with HMAC-SHA256 and a constant-time compare, before parsing anything. Handle:
  - `installation` (created, deleted);
  - `installation_repositories`;
  - `pull_request` (opened, synchronize, reopened, ready_for_review).
- **Auth**: an RS256 JWT through node:crypto, giving an installation access token that is cached until expiry.
- **Linking**: the installation is linked to a team by an owner from a hub settings page (state parameter, CSRF-safe), with the GitHub install URL `https://github.com/apps/<slug>/installations/new?state=…`. Unlinked installations are ignored.
- **PR handling**: list the PR files, call GraphQL `blame` per file (at most 50 files, files ≤ 3 MB), look up `provenanceFor`, render, then upsert the comment and the check run.
- **Reviews**: review statuses come from the team's synced runs.
  - *Changed by the security review (M5)*: the statuses that count are decisions made **in the hub** by a signed-in member (below). Statuses synced from a machine (`grapim review`, `review` events, or a note's `review` field) are shown as "approved locally by ..." and never count.
- **Delivery and rate limits**: idempotent per (delivery id); respect GitHub's rate limits.
- *As built (security review, docs/security-review-github-reports-2026-11-11.md)*: at most one job per installation runs at a time and at most 20 wait; a job stops after 5 minutes and waits at most 60 s for a rate limit; the line mapping reads at most 8 MB of file text, 100 (file, commit) pairs and 50,000 lines per side, and at most 32 MB of notes per pull request. The check run is matched by its App (`app.slug`). `GITHUB_APP_WEBHOOK_SECRET` must be at least 20 characters.
- **Require review (governance plan)**, *as built after the security review (M5, M6)*:
  - **Policy**: `gh_team_policy(team_id, require_review, require_provenance, ...)`, owner only; turning either on needs the governance plan. `require_provenance` defaults on together with `require_review` and can be switched off on its own (for teams with human-only commits from machines without Grapim). Losing the plan makes both inert (neutral check).
  - **Hub reviews**: `hub_reviews(id, team_id, repo_id, run, status, reviewer_user_id, reviewed_at, note, seen_change)` (`src/hub/reviews.js`), one row per decision, the newest wins. A member approves or rejects on the run's hub page (`/hub/teams/:team/repos/:repo/runs/:run`, which shows the run's diff from the synced blobs); the form posts to `POST .../runs/:run/decision` (session, CSRF, team membership, the repo looked up inside the team; a machine token cannot). The reviewer must not be an owner of the run: every hub user whose machine synced rows of that run (`h_changes` or `h_runs`) in any of the team's repos. The syncing user is recorded at ingest as `machines.user_id`, fixed by a machine name's first sync (`machine_taken` refuses any other member). A run with nothing synced: 404, nothing to review.
  - **Stale approvals**: a decision records the run's newest synced change (`seen_change`, an `h_changes.id`). When more changes of the run are synced later, the approval no longer counts until someone approves again.
  - **The decision** (`decide` in `src/hub/github/pull.js`), under `require_review`:
    - **failure** when any added line of the PR comes from an agent run without a current hub approval (a rejection, a stale approval, a local-only approval and no review all fail). Lines of `sync`, `undo` and `restore` runs are people's and need none.
    - **failure** ("not recorded", listing the commits) when `require_provenance` is on and a commit that introduced added lines has no stored note at all. An empty note (`runs: []`, a human-only commit recorded by Grapim) counts as recorded. With `require_provenance` off, such commits are accepted as human, and the summary says how many.
    - **failure** when the App could not check everything: notes it could not read (over the 32 MB budget, or malformed), or a PR with 250 or more commits whose files could not all be attributed line by line.
    - Files the App cannot attribute line by line (past 50 files, over 3 MB, no diff from GitHub, lines it could not map into the commit's version) are checked from the notes instead: the notes of every commit of the PR (`GET /pulls/:n/commits`) are read, and every run a note lists for such a file must be approved, as if all its lines were still there. With `require_provenance`, a non-merge commit of the PR without a note then fails.
    - **success** only when every AI-attributed line is hub-approved and, with `require_provenance`, every commit with added lines has a note. A repo with no mapping is not neutral under the policy: its commits are unrecorded.
    - The check summary starts with what is missing: each unapproved run with its lines, why (not reviewed, rejected by, changed since approved by, approved locally by ... which does not count) and a link to its hub review page; the unrecorded commits; what could not be checked.
  - **Re-evaluation**: each PR's agent runs are kept in `gh_pull_runs` at every check (dropped when the PR closes, or after 90 days without a check). A decision in the hub queues the check of every PR of the team that contains the run, on the App's queue (`reevaluate`), so an approval flips the check without a push. A run that changes after its approval is caught at the next push or decision.
  - **Branch rule (M6)**: GitHub lets any App, and any workflow with `checks: write`, post a check of any name. Customers require the check **from the App**: in the repo's Settings, Rules, Rulesets (or Branches, Branch protection rules), for the default branch, turn on "Require status checks to pass", add `Grapim provenance (app)`, and set its source to the GitHub App "Grapim", not "any source". The hub's GitHub settings card shows these steps.
  - **What it attests**: lines are attributed from notes that members' machines record. It stops self-approval, approvals made outside the hub, unrecorded commits (with `require_provenance`) and unchecked files. It does not stop a member who changes their own client to write false notes (team-internal poisoning, L10). Every hub decision is kept with its reviewer and time.

## 7. Reports (hub, `src/hub/reports/`)

- **Team pages and a JSON API** `GET /hub/api/teams/:team/reports/<name>?from=&to=&repo=`:
  - `ai-share`: the AI-written share of added lines by week, repo and agent kind (from provenance notes);
  - `agents`: per agent kind and run label prefix, the runs, lines, undo rate (undone runs ÷ runs), reject rate and median review time;
  - `unreviewed`: AI-authored lines merged (present in provenance for commits on the default branch, when known) from runs not approved;
  - `activity`: runs per day, files touched, blocks and conflicts.
- **CSV export** for each report.
- **Design**: dense, Linear-like charts drawn as inline SVG (no chart library), the same tokens as the review desk, and accessible (data tables behind each chart).
- **Gating**: reports and the `require_review` policy (with `require_provenance`) are on the **governance** plan. Add it to billing's plans: $40 per seat per month (or $384 a year), with Team at $20 unchanged. The free and team plans see a teaser with last week's AI share only.
- **As built** (src/hub/reports/):
  - `from` and `to` are UTC dates `YYYY-MM-DD`, both inclusive; the default is the 12 weeks up to today, at most 366 days, and never earlier than the plan's history window. `repo` is a repo id of the team (404 otherwise).
  - CSV: the same path with `.csv` (`/reports/ai-share.csv?…`).
  - A team without the feature gets 402 `plan_required`, with `teaser` (last week's AI share) in the body.
  - Every report has `coverage` (repos with provenance of all repos, commits, notes dated by upload, rows scanned, whether a cap was hit). Grapim writes a note for every recorded commit (with `commit.added`), so within recorded commits the denominator is the sum of `commit.added`, AI lines come from the ranges, and human lines are added − AI (lines of `sync`, `undo` and `restore` runs are people's, so human). Commits with no note are not recorded: their lines are unknown, shown only as a coverage gap (repos with no notes), never as human. A note without `commit.added` (an older client) counts its AI lines but stays out of the share and the human lines.
  - `agents` leaves out `undo`, `restore` and `sync` runs. A run is undone when an `undo:` run is labelled `undo <its label or id>`. Review state is the run's newest synced `review` event, else the note's `review`, else `pending`. Reject rate is rejected ÷ reviewed runs. Review time runs from the run's last change before the review to its first approve or reject.
  - `activity`: blocks are `blocked` events; conflicts are files that two or more runs changed on the same day.
  - Work is capped (notes, note bytes and rows scanned per report) and results are cached per team for at most an hour, keyed on the team's newest sync and newest note, so a sync shows at once.
  - *Security review*: each team may spend at most 5 s of report compute per minute; past it the newest cached answer for the same query is served, else 429. The teaser follows syncs at most every 10 minutes. The note scan cap is 32 MB. CSV cells that start with a formula character (also after spaces, or full-width) get a leading `'`, and cells with `;` or a tab are quoted.
  - Tables: `h_provenance` exactly as in section 3; reports also add indexes `h_provenance(team_id, received_at)`, `h_changes(team_id, ts)` and `h_events(team_id, kind, ts)`.
  - *Security review (M5)*: the review state in `agents` and `unreviewed` is the run's newest decision in the hub (`hub_reviews`) when there is one, else its newest synced `review` event, else the note's `review`. The reports say so; only hub approvals count for the `require_review` check.
  - *Pricing copy*: Governance is $40 per seat a month ($384 a year): the reports, plus Require review, a GitHub check that fails a pull request until a teammate other than the run's author approves each agent run in the hub, and (Require provenance) until every commit that adds lines is recorded.
