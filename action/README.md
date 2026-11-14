# Grapim provenance Action

Comments on every pull request with where its added lines came from: the share written by AI agents, a row per agent run with its prompt and its review status in Grapim, the runs nobody approved yet, and a per-file breakdown. The comment is updated in place on every push.

It reads the git notes Grapim writes at commit time (`refs/notes/grapim`, see `docs/provenance.md`). Turn them on once per repo with `grapim init`, which installs the hooks that record a note per commit and push the notes with your branches.

## Workflow

`.github/workflows/grapim-provenance.yml`:

```yaml
name: Grapim provenance
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  provenance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # blame needs the history; notes are fetched by the action
      - uses: grapim/grapim/action@main
```

Pin a release tag or a commit sha instead of `main` once you depend on it.

## What it does

1. Fetches `refs/notes/grapim` from `origin`, and the base and head commits if the checkout lacks them (a shallow checkout is unshallowed).
2. Takes the lines the pull request adds (its diff from the merge base), runs `git blame` on them at the head, and looks up the note of each commit that introduced one.
3. Creates or updates one comment, found by the `<!-- grapim:provenance -->` marker.

It never runs code from the repository: diffs and blame run with `--no-ext-diff` and `--no-textconv`.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write`. |
| `max-files` | `300` | Files attributed per pull request; the comment notes the rest. |

Outputs: `added-lines`, `ai-lines`, `ai-share` (0 to 1) and `unreviewed-runs`, for reports and dashboards. They are not a merge gate (below).

## Informational only: never a merge gate

This is the provenance Action. Grapim Review, the AI review Action in [`action/review`](review/README.md), is different: it fails its job when it finds a blocker (`fail-on: blocker`), and you can make that job a required check.

The Action's comment and outputs describe the pull request. They never block a merge, and you should not make this workflow (or a step that reads `unreviewed-runs`) a required status check:

- Its review statuses are what collaborators' machines recorded (`grapim review`, the notes' `review` field). Anyone can approve their own run that way.
- The workflow runs from the pull request's branch, so the pull request can change or skip it.

To require approval before merge, use the Grapim GitHub App with the team's **Require approval** policy (Governance plan). Its check, **Grapim provenance (app)**, only passes when another team member has approved each agent run on its page in the Grapim hub, and (with Require provenance) when every commit that adds lines has a note. In the repo's **Settings**, **Rules**, **Rulesets** (or **Branches**, **Branch protection rules**), for the default branch:

1. Turn on **Require status checks to pass**.
2. Add the check `Grapim provenance (app)`.
3. Set its source to the GitHub App **Grapim**, not "any source". Otherwise a workflow, this one included, or another App could post a passing check with the same name.

## Security

- Use `on: pull_request`, not `pull_request_target`. The Action never runs code from the pull request, but `pull_request_target` gives a fork's pull request a write token and your secrets, and a checkout of its head in the same job would run its code with them.
- Notes are what your collaborators' machines recorded: anyone who can push `refs/notes/grapim` can write one. Gate merges on the Grapim App's check, required from the Grapim App as above, never on this Action.

## Forks, no notes, big pull requests

- **Forks.** A `pull_request` from a fork gets a read-only token, so the summary is printed to the job log and the job summary, and the job passes.
- **No notes yet.** The pull request gets a short comment saying how to enable provenance, once. It turns into the summary when notes show up.
- **Big pull requests.** At most `max-files` files are attributed; the comment says how many were not. The comment stays under GitHub's 65,536-character limit by shortening the tables, never by cutting text in half.

## Locally

The same summary, from your clone:

```bash
grapim provenance pr origin/main..HEAD          # Markdown
grapim provenance pr origin/main..HEAD --json   # the numbers
```

## Development

The action imports `dist/render.js` and `dist/pr.js`, copies of `src/provenance/`. After changing those, run `node action/bundle.mjs` (`--check` fails when `dist/` is stale; the test suite checks it too).
