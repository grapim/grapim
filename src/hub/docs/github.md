---
title: The GitHub App and the PR check
nav: GitHub App and PR check
description: A comment on every pull request listing its agent runs, and a check that blocks merging until every run is approved.
---
## What it does

With the Grapim GitHub App installed, every pull request in the repos you choose gets:

- **A comment**, updated on every push: how many of the pull request's agent runs are not reviewed yet, a table of the runs with their lines, files, prompt and review status, a list of the runs still to review, and the share of added lines that came from agent runs.
- **A check** named `Grapim provenance (app)`. It is neutral (information only) until you turn on Require review.

The App reads the pull request's files and blame to attribute lines. It does not change code, push commits or approve pull requests.

## Install it

You need to be an owner of the team.

1. In the hub, open **Settings**, then **GitHub**, and choose **Install on GitHub**.
2. On GitHub, pick the account or organization and the repositories, and confirm.
3. GitHub sends you back to the hub, which links the installation to your team.

Pull requests are matched to your synced repos by the GitHub name that `grapim sync` reads from the repo's `origin` remote, so sync at least once from each repo.

Once linked, Grapim also reads the last 90 days of merged pull requests and shows how many had commits from AI agents, and how many merged without another person's approval: see [AI history scan](/docs/history).

## Require review

On the **Governance** plan (a pilot during early access: [talk to us](/docs/support)), an owner can turn on **Require review** in Settings, GitHub. The check then:

- **fails** while any line the pull request adds comes from an agent run that is not approved in the hub. A rejection, an approval that went stale, a local-only approval and no review at all each fail it;
- **passes** when every agent run in the pull request is approved by a member other than the person who synced it.

The check's summary starts with what is missing: each run with its lines, why it does not count, and a link to its review page. An approval in the hub queues the check again for every open pull request containing that run, so it turns green without a push.

**Require provenance** comes on with Require review: a commit that adds lines but has no Grapim note fails the check, because nobody can tell whether an agent wrote it. If some people commit from machines without Grapim, an owner can turn it off; those commits are then accepted as human, and the summary says how many.

With [path rules](/docs/rules), runs that change sensitive paths need more approvals, or approvals from named people, before the check passes.

## Approve from GitHub

The check carries an **Approve** button for each run still waiting (up to three, GitHub's limit), and the comment links each run to its review page in the hub. A click records an approval in Grapim as the GitHub user who clicked, under the same rules as the hub:

- they must be a member of the team in Grapim (members sign in with GitHub, so their GitHub account is known);
- they must not be the person who synced the run;
- [path rules](/docs/rules) that name approvers apply.

Grapim trusts only GitHub's signed record of who clicked (the account's numeric id), never a name in the request. A click that does not count records nothing, and the check's next summary says why. The run page shows approvals made this way as "from the GitHub check".

GitHub shows the buttons once the check completes. The run's full diff is on its review page in the hub; the button is for when you have already read the change in the pull request.

## Make it block merging

A failing check blocks merging only when GitHub requires it. In the repository on GitHub, open **Settings**, **Rules**, **Rulesets** (or **Branches**, **Branch protection rules**) for your default branch:

1. Turn on **Require status checks to pass**.
2. Add the check `Grapim provenance (app)`.
3. Set its source to the GitHub App **Grapim**, not "any source". Otherwise a workflow or another App could post a passing check with the same name.

## What the check proves, and what it does not

It proves that every agent-written line in the pull request, as recorded by your team's machines, comes from a run that a different teammate approved in the hub, and, with Require provenance, that every commit adding lines was recorded.

It relies on those records. A member who changes their own Grapim client to write false notes can mislead it. Every decision in the hub is kept with its reviewer and time.

## Without the App

`grapim provenance pr main..HEAD` prints the same summary on your machine, from git and the notes alone.
