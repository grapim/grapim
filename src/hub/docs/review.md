---
title: AI review
nav: AI review
description: Grapim Review is an AI code reviewer that runs in your own GitHub Actions and comments on each pull request. Your code goes only to the model account you choose.
---
## What it does

On every push to a pull request, the Grapim Review job reads the diff and asks Claude to review it, through your own model account. It posts one review with a comment on each line that needs attention, and keeps one summary comment up to date.

It reads the notes Grapim records at commit time, so it knows which agent run wrote each line and what that run was asked to do. On agent-written lines it checks that the change does what was asked and nothing else: scope creep, deleted tests, weakened checks, secrets, destructive migrations. Without notes it still reviews, and treats every line as written by a person.

## Where your code goes

Only to the model account you set up: the Anthropic API with your key, Amazon Bedrock in your AWS account, Google Vertex AI in your Google Cloud project, or Microsoft Foundry. The job runs on your GitHub runner, calls that endpoint directly, and posts to GitHub with the workflow's own token.

Grapim's servers receive nothing: no code, no diffs, no findings, no telemetry. You do not need a Grapim account to use it.

## Set it up

1. **Choose the model account** that will review your code.
2. **Add the workflow file and its credentials** for that account, below.
3. **Open a pull request.** The review appears on it within a few minutes.

Each file below is the whole workflow. Save it as `.github/workflows/grapim-review.yml` on your default branch. Pin a release tag or a commit sha instead of `main` once you depend on it.

### Anthropic API

Add your Anthropic API key as the repository secret `ANTHROPIC_API_KEY`: on GitHub, the repository's **Settings**, **Secrets and variables**, **Actions**, **New repository secret**.

```yaml .github/workflows/grapim-review.yml
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

### Amazon Bedrock

No long-lived keys: the job signs in with GitHub's OIDC token. Create an IAM role that trusts GitHub's OIDC provider for this repository and may invoke Claude models on Amazon Bedrock. Put its ARN and your region in the file.

```yaml .github/workflows/grapim-review.yml
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

`configure-aws-credentials` sets `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` for the later steps. The review step signs its requests with them.

### Google Vertex AI

Set up Workload Identity Federation for the repository, with a service account that can call Claude on Vertex AI. Put the provider, the service account and your project in the file.

```yaml .github/workflows/grapim-review.yml
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

```yaml .github/workflows/grapim-review.yml
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

### Open a pull request

Open a pull request, or push to one that is open. The job **Grapim Review / review** shows up in the pull request's checks and in the repository's **Actions** tab. When it finishes, the review is on the pull request.

The result stays on GitHub. The Grapim hub does not receive it, so nothing changes in the hub when a review is posted.

If no review appears, open the job's log in the **Actions** tab. Each problem is written there in plain words, for example a missing secret or a model that is not enabled in your account. A pull request from a fork gets no secrets from GitHub, so it is not reviewed and the job passes.

## The config file

`.grapim/review.json` in the repository. Every key is optional; the values below are the defaults, apart from `instructions`. An unknown key or a wrong value stops the run with a plain message, and nothing is posted.

```json .grapim/review.json
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

| Key | Default | What it does |
|---|---|---|
| `model` | `claude-opus-5-5` | The Claude model id in your account. |
| `review` | `ai-and-sensitive` | `ai-and-sensitive` reviews agent-written lines and any line on a `sensitive` path. `all` reviews every changed line. `ai-only` reviews agent-written lines only. |
| `sensitive` | as above | Paths that always get a review. Agent-written lines on these paths get the deepest one. Your list replaces the default. |
| `ignore` | as above | Paths never sent to the model. Your list replaces the default. |
| `instructions` | empty | Your team's own rules, added to every review. |
| `maxComments` | `15` | The most severe findings are kept. |
| `maxFiles` | `100` | Riskiest files first; the rest are listed as not reviewed. |
| `failOn` | `blocker` | `blocker` fails the job when the review finds a blocker. `never` only comments. |

The review always reads this file from the pull request's **base** branch, never from the pull request itself. A pull request cannot loosen its own review, for example with `"ignore": ["**"]` or `"failOn": "never"`. A change to the file takes effect once it is merged.

The workflow can also set `provider`, `model`, `fail-on` and `config-path` as inputs under `with:`. An input wins over the config file.

## What the comments look like

One review per push, with a comment on each line that needs attention. On an agent-written line the comment ends with the run that wrote it and what that run was asked. For example:

```text Comment on src/orders/create.ts
Blocker · Idempotency key read from untrusted header without length limit

The key from the Idempotency-Key header is stored as is. A client can
send a 1 MB header and it is written to the orders table on every retry.

Written by Claude Code run: "Add idempotency keys to POST /orders"
```

The review is a comment. It never uses "request changes" and never approves.

One summary comment is updated in place on every push: counts by severity, which agent runs were reviewed and how deeply, what was skipped and why, the model, the provider and the tokens used. It ends with where the code went:

```text Summary comment, last line
Your code was sent only to Anthropic API. Grapim received nothing.
```

Text from the diff, a note or the model's answer is shown as plain text: no links, no @mentions, no HTML.

## Block merging on a blocker

With `failOn` set to `blocker` (the default), the job fails after posting when the review finds a blocker. To stop such a pull request from merging, make the job a required check: in the repository's **Settings**, **Rules**, **Rulesets** (or **Branches**, **Branch protection rules**), turn on **Require status checks to pass** and add the check **review** (the job's name in the file).

The workflow file itself comes from the pull request's branch, so a pull request could edit the job. When the job is a required check, protect `.github/workflows/` with a CODEOWNERS entry and turn on **Require review from Code Owners**.

This is separate from the Grapim GitHub App's check, which waits for a teammate's approval of each agent run in the hub: see [GitHub App and PR check](/docs/github). You can require both.

## Run it on your machine

The same review on a local branch, printed to the terminal. It uses the credentials in your environment, for example `ANTHROPIC_API_KEY`.

```sh
npm install -g grapim
grapim review --ai origin/main..HEAD
```

It exits with code 1 when it finds a blocker. Options are in the [CLI reference](/docs/cli).

## Limits and costs

- **Model costs are yours.** Every request goes to your model account and is billed there by the provider. Grapim does not charge for the review or see your usage. The summary comment lists the tokens each review used.
- **What gets reviewed.** Under the default, human-written lines outside `sensitive` paths are skipped, which keeps the cost down. `"review": "all"` reviews everything.
- **Size.** Up to `maxFiles` files per review, riskiest first. A review sends at most about 600,000 input tokens. Files over the limit are listed as not reviewed.
- **When a request fails.** A request that still fails after retries, or that the model declines, is listed under not reviewed in the summary. Rejected credentials or a model that is not enabled stop the job with a failure.
- **Forks.** A pull request from a fork gets no secrets, so it is not reviewed and the job passes.
