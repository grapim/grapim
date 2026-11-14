---
title: Approving runs
nav: Approving runs
description: Find the runs that need you, read what each was asked and what it changed, and approve or reject it.
---
## The approvals inbox

Your team's **Approvals** page has three tabs:

- **Needs your approval**: runs synced by teammates that nobody has approved yet.
- **Your runs**: runs you synced. Someone else approves these.
- **Decided**: every decision, newest first.

The number next to Approvals in the sidebar is how many runs are waiting for you.

## A run's page

Open a run to see:

- the agent, the machine that synced it, the repo, its turns, and lines added and removed;
- each turn's prompt and the files it touched;
- the diff of every file, as synced;
- the pull requests its lines are in, once the [GitHub App](/docs/github) is installed;
- whether its changes are still in the working tree on that machine.

Choose **Approve** or **Reject**, with an optional note. Every decision is kept with who made it and when.

## The rules

- **Not your own runs.** The person who synced a run cannot approve it. A machine name belongs to the member who first synced from it.
- **Changed after approval means not approved.** If more changes of a run are synced after it was approved, the approval stops counting until someone approves again.
- **Only hub decisions count.** `grapim review <run> --approve` on a machine marks the run locally; the pull request check shows it as approved locally but does not count it.
- **Sensitive paths can need more.** With [path rules](/docs/rules), a run that changed `payments/**`, say, can need two approvals, or approvals from named people. The run page shows which rules apply and who still needs to approve.
- **Rejecting does not undo.** A rejection keeps the check failing; to take the code out, [undo the run](/docs/undo) on the machine that made it.

## Faster approvals

- **Approve from the pull request.** The `Grapim provenance (app)` check has an Approve button per waiting run, under the same rules: see [Approve from GitHub](/docs/github#approve-from-github).
- **Get told in Slack** when runs are waiting: see [Slack notifications](/docs/notifications).

- Press **Ctrl K** (**Cmd K** on a Mac) to jump to any run waiting for your approval.
- **Ask about this run** on a run page opens [Ask Grapim](/docs/ask-grapim) with the run in view: ask what it changed and why, then confirm the approval it prepares.
