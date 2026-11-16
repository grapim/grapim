---
title: We ran our reviewer on 69 pull requests written with Claude Code
nav: 69 Claude Code PRs
description: What an AI reviewer found on 69 public pull requests marked "Generated with Claude Code", how often it was wrong, and what we changed because of it.
---
**16 November 2026**

Grapim Review became free for public repositories on 15 November. Before asking any maintainer to install it, we wanted to know how it does on code we did not write. So we took public pull requests that say "Generated with Claude Code", ran the same review the GitHub App runs, and read every comment it would have posted against the code itself. Nothing was posted to those PRs.

## What we ran

69 pull requests from 69 repositories, in three rounds:

- 8 PRs from teams we already knew used Claude Code.
- 50 PRs from repositories with 30 or more stars, between 80 and 800 changed lines, one per repository.
- 11 PRs from very busy repositories, the kind that merge hundreds of PRs a month.

Each review compared the PR head with the merge base, the same way the App does.

## How often it said anything

Most PRs got no comment at all. On the first 8 it posted nothing; it held back four low-confidence notes, and one of those turned out to be right. Across all 69, it would have posted 33 findings, on fewer than a third of the PRs.

## How often it was right

For each of the 33 findings we read the code at the PR head and the whole PR thread. 19 were real, 13 were wrong, and 1 we could not settle. That is 58% right, which is not good enough to post on a stranger's PR.

Real is also not the same as worth reading. Of the 19, several had already been raised by a maintainer or another bot, some were already fixed on the main branch, and a few were too small to matter. About 8 were things we would want to hear about on our own code. We are telling those maintainers privately, one email at a time, and not posting them anywhere. That is also why this page names no projects.

## What the real ones looked like

Most of them sit between two places in the code, or between the change and something outside the diff:

- A login captcha got a rate limit per client IP. A helper elsewhere in the project trusts the `X-Forwarded-For` header by default. Each choice is fine alone. Together, someone who knows your IP can keep you off the login page.
- A background process is told to start watching for input when a panel opens. If the process restarts while the panel is open, nobody tells the new one, and the feature quietly stops until the panel is closed and opened again.
- Documentation samples that do not compile in the default project template, because the template turns on implicit usings and a type name becomes ambiguous.
- A name parser that would turn `ABC HOME CARE, LLC` into a person whose first name is LLC.

None of these is hard to see once someone points at it. They are the kind of thing an agent misses when it changes one file well and does not look at the file next to it.

## What the wrong ones looked like

The most common cause: the author had already explained the change, in the PR thread or in a later commit, and the review never read it. Next most common: the bug needed a condition that cannot happen in that codebase. A few times the review thought a number was wrong and it was right.

One mistake was ours. Our first run compared against the base branch as it is today rather than the merge base, so newer commits on main looked like the PR was reverting them. Nine false findings on one PR came from that. The App always used the merge base. Our test script did not, and now it does.

## What we changed

Grapim now takes a second look before it posts. One more model call reads the commits, the PR discussion and the code around each finding, and drops any finding the evidence contradicts. It only reads discussion from the PR author and people with write access, so a passing comment from a stranger cannot hide a finding.

On the 26 labelled findings from the 50-PR round, the second look dropped 6 of the 9 wrong ones and 2 of the 17 real ones, which takes precision from 65% to 83%. That is the set we built it against, so treat that number as optimistic. On the 11 fresh PRs afterwards it correctly dropped 1 of 6 findings, and 3 of the 5 it kept were still wrong. Better, not solved.

The same week we also stopped it from repeating a finding after a new push, let you reply to it with `@grapim`, and made it learn from 👍, 👎 and replies by people on the team.

## Try it on your own PRs

If you maintain a public repository, the [GitHub App](/docs/github) reviews it for free with no account. When it is wrong, say so in the thread. That is how we find the next thing to fix. The review code is open source at [github.com/grapim/grapim](https://github.com/grapim/grapim).
