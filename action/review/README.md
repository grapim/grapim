# Grapim Review Action

An AI code reviewer that runs in your own CI. It posts one review per push with inline comments on the lines that need attention, and keeps one summary comment up to date. It knows which agent run wrote each line and what that run was asked to do, so on agent-written lines it checks that the change does what was asked, and nothing else: scope creep, deleted tests, weakened checks, secrets, destructive migrations.

It reads the git notes Grapim writes at commit time (`refs/notes/grapim`, see `docs/provenance.md`). Without notes it still reviews, treating every line as human-written (see `review` in the config below).

## Where your code goes

Only to the model endpoint you configure: the Anthropic API with your key, Amazon Bedrock in your AWS account, Google Vertex AI in your project, or Microsoft Foundry. The Action runs on your runner, calls that endpoint directly, and posts to GitHub with the workflow's token. Grapim's servers receive nothing: no code, no diffs, no findings, no telemetry.

## Permissions

```yaml
permissions:
  contents: read
  pull-requests: write
```

Add `issues: read` if the repository is private and you want the review to read the issues a pull request closes (see "What it compares with"); without it those issues are left out and the review goes on. Add `id-token: write` for Bedrock or Vertex with OIDC (below). Credentials go in `env`, from secrets or from the cloud's auth action. The Action has no input for them, so they never show up in the inputs it logs.

## Workflow

`.github/workflows/grapim-review.yml`. Pick the file for your model provider. Each one is the whole workflow.

### Anthropic API

Add your Anthropic API key as the repository secret `ANTHROPIC_API_KEY` (**Settings**, **Secrets and variables**, **Actions**).

```yaml
name: Grapim Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: grapim/grapim/action/review@main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Amazon Bedrock (OIDC, no long-lived keys)

Create an IAM role that trusts GitHub's OIDC provider for this repository and may invoke Claude models on Amazon Bedrock. Then:

```yaml
name: Grapim Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  id-token: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/grapim-review
          aws-region: us-east-1
      - uses: grapim/grapim/action/review@main
        with:
          provider: bedrock
```

`configure-aws-credentials` sets `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` for the later steps; the Action signs its requests with them.

### Google Vertex AI

Set up Workload Identity Federation for the repository, with a service account that can call Claude on Vertex AI. Then:

```yaml
name: Grapim Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  id-token: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: gcp
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/123456789/locations/global/workloadIdentityPools/github/providers/github
          service_account: grapim-review@my-project.iam.gserviceaccount.com
          token_format: access_token
      - uses: grapim/grapim/action/review@main
        with:
          provider: vertex
        env:
          GOOGLE_CLOUD_PROJECT: my-project
          GOOGLE_CLOUD_REGION: global
          GOOGLE_OAUTH_ACCESS_TOKEN: ${{ steps.gcp.outputs.access_token }}
```

### Microsoft Foundry

Add your Foundry API key as the repository secret `ANTHROPIC_FOUNDRY_API_KEY`, and put your Foundry resource name in the file.

```yaml
name: Grapim Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: grapim/grapim/action/review@main
        with:
          provider: foundry
        env:
          ANTHROPIC_FOUNDRY_API_KEY: ${{ secrets.ANTHROPIC_FOUNDRY_API_KEY }}
          ANTHROPIC_FOUNDRY_RESOURCE: my-foundry-resource
```

Pin a release tag or a commit sha instead of `main` once you depend on it.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write`. |
| `provider` | from the environment | `anthropic`, `bedrock`, `vertex` or `foundry`. Empty: `GRAPIM_REVIEW_PROVIDER`, else the provider whose credentials are set. |
| `model` | the config's `model` | Model id, for example `claude-opus-5-5`. |
| `fail-on` | the config's `failOn` (`blocker`) | `blocker` fails the job when a blocker is found, after posting. `never` only comments. |
| `config-path` | `.grapim/review.json` | The config file, relative to the repository root. |
| `use-pr-request` | `true` | `true` compares the change with what the pull request asked for (below). `false` leaves the title, description and linked issues out of the review. |

Outputs: `blockers`, `warnings`, `nits` and `reviewed-hunks`.

## What it compares with

The review checks the change against what was asked for, with or without Grapim's notes:

- **Linked issues**: the issues the pull request description closes with GitHub's closing keywords (`Closes #12`, `Fixes: #3`, `Resolves acme/api#7`, or the issue's URL), in this repository only, at most 3. They are read with `github-token`; one that cannot be read (deleted, private without `issues: read`) is left out. These count as what was asked.
- **The pull request's title and description**: what the author says the change does. An agent often writes the description after the work, describing the result rather than the request, so the reviewer weighs it below a linked issue.
- **Agent run prompts** from the notes stay the authority for the lines those runs wrote.

The reviewer reports only a concrete mismatch (asked for X, the change does Y; or a change nobody asked for), never wording or style. The request is untrusted text like the diff: it is fenced off, capped at about 2,000 tokens per request to the model, and instructions inside it are never followed. It never changes which lines are reviewed. When it was used, the summary comment says so in one line, for example **Compared with:** issue #12, PR description.

## Config

`.grapim/review.json`, every key optional. An unknown key or a wrong value stops the run with a plain message, and nothing is posted.

```json
{
  "model": "claude-opus-5-5",
  "review": "ai-and-sensitive",
  "sensitive": ["**/migrations/**", "**/auth/**", "**/infra/**", "**/*.sql", ".github/workflows/**"],
  "ignore": ["**/*.lock", "**/dist/**", "**/*.snap"],
  "instructions": "Our services must never log account numbers.",
  "maxComments": 15,
  "maxFiles": 100,
  "failOn": "blocker"
}
```

- `review`: `ai-and-sensitive` (default) reviews agent-written lines and any lines on `sensitive` paths; `all` reviews every changed line; `ai-only` reviews agent-written lines only.
- Agent-written lines on sensitive paths get the deepest review; human-written lines outside sensitive paths are skipped under the default.
- `maxComments` keeps the most severe findings; `maxFiles` caps the files reviewed.

## What it posts

1. One pull request review (`COMMENT`, never "request changes") on the head commit, with an inline comment per finding: `**Blocker · title**`, the explanation, and for agent-written lines the run that wrote them and its prompt. A re-run on the same commit does not post a second review.
2. One summary comment, found by its `<!-- grapim:review -->` marker and updated in place on every push: counts by severity, which agent runs were reviewed and how deeply, what was skipped and why, the model and provider. A finding GitHub will not attach to the diff goes here instead.

Everything taken from the diff, a note or the model's answer is shown as plain text: no links, no @mentions, no HTML.

## Forks

A `pull_request` from a fork gets a read-only token and no secrets, so there are no model credentials: the job logs that nothing was reviewed and passes. If you supply credentials some other way, the review goes to the job summary and the log instead of the pull request.

## Security

- Use `on: pull_request`, not `pull_request_target`. The Action never runs code from the pull request, but `pull_request_target` gives a fork's pull request your secrets.
- `.grapim/review.json` (or your `config-path`) is always read from the pull request's **base** commit, so a pull request cannot loosen its own review (for example `ignore: ["**"]` or `failOn: never`). A config change takes effect once it is merged.
- The workflow file itself still comes from the pull request's branch on `pull_request` events. If you make the job a required check, protect `.github/workflows/` with CODEOWNERS.
- The Action never runs code from the repository: git diffs and blame run with `--no-ext-diff` and `--no-textconv`.

## Locally

The same review, on your branch, printed to the terminal:

```bash
grapim review --ai origin/main..HEAD
grapim review --ai origin/main..HEAD --json
grapim review --ai origin/main..HEAD --request-file task.md
```

Without `--request-file`, it compares with the branch's open pull request and the issues it closes when the `gh` CLI is installed and signed in, and goes without otherwise.
