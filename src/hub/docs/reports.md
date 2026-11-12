---
title: Reports
nav: Reports
description: How much code agents write, what reached the default branch without review, and how each agent performs.
---
Reports are on the **Governance** plan. Teams on Free and Team see a preview with last week's AI share. There is no checkout during early access; Governance is available as a pilot, so [talk to us](/docs/support) to try it.

## The four reports

| Report | What it answers |
|---|---|
| Merged without review | AI-written lines that reached the default branch from runs nobody approved: pending, rejected or never reviewed, by run, repo and agent. |
| AI share | The share of added lines that agents wrote, by week, repo and agent. |
| Agents | Per agent: runs, lines, undo rate, reject rate and median review time. |
| Activity | Runs per day, files touched, edits that were blocked, and files two runs changed on the same day. |

Pick a range (4 weeks, 12 weeks, 6 months, a year, or exact dates) and a repo. The range is limited to your plan's history: 365 days on Governance.

## Export

Every report has **Export CSV**, with the same range and repo. Cells that a spreadsheet would read as a formula are made inert.

## How the numbers are counted

- AI lines come from the [provenance notes](/docs/concepts#provenance-notes); human lines are the rest of the lines in recorded commits.
- Commits without a note were not recorded. Their lines are **unknown**: shown as a coverage gap, never counted as human. Each report says how many repos and commits it covers.
- Lines from undo, restore and folder-sync runs are people's work.
- The review state of a run is its newest decision in the hub.

Reports are cached for up to an hour, and refreshed as soon as a machine syncs.
