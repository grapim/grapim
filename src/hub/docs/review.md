---
title: AI review
nav: AI review
description: Grapim Review is an AI code reviewer that comments on each pull request. Turn it on in the GitHub App, or run it in your own GitHub Actions on your own model account.
---
## What it does

On every push to a pull request, Grapim Review reads the diff and asks Claude to review it. It posts one review with a comment on each line that needs attention, and keeps one summary comment up to date.

It reads the notes Grapim records at commit time, so it knows which agent run wrote each line and what that run was asked to do. On agent-written lines it checks that the change does what was asked and nothing else: scope creep, deleted tests, weakened checks, secrets, destructive migrations. A repository without notes still gets every changed line reviewed.

It runs in one of two ways:

- **Cloud review**: install the Grapim GitHub App and turn it on. Grapim runs the review on its own model account. Nothing to set up in CI.
- **In your own CI**: add one workflow file. The review runs on your GitHub runner with your own model account, and Grapim's servers receive nothing.

## Cloud review

1. Sign in at [app.grapim.com](https://app.grapim.com) and connect the GitHub App: **Settings**, **GitHub**, **Connect**.
2. On the same page, turn on **Cloud review**.
3. Open a pull request, or push to one. A **Grapim Review (cloud)** check appears at once, and the comments follow, usually within a minute or two.

Each review fetches the pull request's base branch, its head and the Grapim notes into a temporary folder on Grapim's server, sends the changes to Anthropic (Claude Opus 5.5) for the review, and deletes the folder when it ends. The App's token is used only for that pull request. Your `.grapim/review.json` on the base branch applies, as in CI.

Each plan includes a monthly review credit (Free: about 50 pull requests). Settings, GitHub shows how much is used. When it runs out, the check says so and nothing is sent to the model until the next month.

### Free for open source

Public repositories are reviewed free. [Install the GitHub App](https://github.com/apps/grapim) on a public repository and open a pull request: there is no account to create and nothing to turn on. A team that has cloud review on gets its public repositories reviewed without using its credit.

- Only repositories that GitHub reports as public. A private repository needs a team with cloud review on.
- Pull requests opened by bots, such as dependency updates, are skipped.
- A repository with fewer than 10 stars is reviewed when someone asks: comment `@grapim review` on the pull request. From 10 stars, every push is reviewed.
- Each pull request author gets up to 5 free reviews an hour in a repository. Past that, the check says when the next one is available.
- Each repository can use about 50 free reviews a month, out of a shared monthly pool. When either runs out, the check says so and reviews start again next month.
- Grapim only comments on repositories where someone installed it. Uninstall the App and it stops.
- The summary comment ends with one line saying the review is free for public repositories.

### On every new push

Grapim reviews the new head, but a finding it already posted on the pull request (same file, same or nearly the same title) is not posted again. The summary says how many earlier findings are still there, and a blocker that is still there still fails the check.

### Ask Grapim in the pull request

Mention the App in a comment: `@grapim is this really a problem?` under one of its comments, or `@grapim what does this change break?` in the conversation. Grapim answers with the diff, the description and that thread in front of it. `@grapim review` runs a fresh review of the head.

- People with write access, and the pull request's author, can ask. Comments from bots are ignored.
- Answers use the same review credit (or the free pool for public repositories), at most 20 a day per pull request.
- The model has no tools: it can only write the reply.

### It learns from your team

Before each review, Grapim reads its recent comments in the repository back from GitHub: 👎 and 👍 on them, and the replies written under them by people with write access. That goes to the reviewer as guidance, so a kind of finding your team keeps dismissing comes up less. Nothing is stored on Grapim's side for this, and replies from people without write access are left out. A blocker is still reported.

## Run it in your own CI

The rest of this page sets up the review as a GitHub Action.

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
  "review": "all",
  "sensitive": ["**/migrations/**", "**/auth/**", "**/infra/**", "**/*.sql", ".github/workflows/**"],
  "ignore": ["**/*.lock", "**/dist/**", "**/*.snap"],
  "instructions": "Our services must never log account numbers.",
  "maxComments": 15,
  "maxFiles": 100,
  "failOn": "blocker",
  "passes": 1
}
```

| Key | Default | What it does |
|---|---|---|
| `model` | `claude-opus-5-5` | The Claude model id in your account. |
| `review` | `all` | `all` reviews every changed line. `ai-and-sensitive` reviews agent-written lines and any line on a `sensitive` path, which costs less. `ai-only` reviews agent-written lines only. |
| `sensitive` | as above | Paths that always get a review. Agent-written lines on these paths get the deepest one. Your list replaces the default. |
| `ignore` | as above | Paths never sent to the model. Your list replaces the default. |
| `instructions` | empty | Your team's own rules, added to every review. |
| `maxComments` | `15` | The most severe findings are kept. |
| `maxFiles` | `100` | Riskiest files first; the rest are listed as not reviewed. |
| `failOn` | `blocker` | `blocker` fails the job when the review finds a blocker. `never` only comments. |
| `passes` | `1` | How many times each change is reviewed, 1 to 3. With 2 or more, a high-confidence finding is posted from any pass and a medium-confidence one only when two passes raised it; the rest are listed under "Worth a look". About a third more cost and twice the time. |

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
- **What gets reviewed.** By default every changed line. `"review": "ai-and-sensitive"` skips human-written lines outside `sensitive` paths to keep the cost down; a repository with no Grapim notes yet has no known authors, so it reviews every changed line there too.
- **What gets posted.** The reviewer rates how sure it is of each finding. High and medium findings become inline comments. Low ones are listed in the summary under "Worth a look", one line each.
- **Size.** Up to `maxFiles` files per review, riskiest first. A review sends at most about 600,000 input tokens. Files over the limit are listed as not reviewed.
- **When a request fails.** A request that still fails after retries, or that the model declines, is listed under not reviewed in the summary. Rejected credentials or a model that is not enabled stop the job with a failure.
- **Forks.** A pull request from a fork gets no secrets, so it is not reviewed and the job passes.
