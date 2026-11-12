---
title: Path rules
nav: Path rules
description: Require more approvals, or approvals from named people, for agent runs that change sensitive paths. Like CODEOWNERS, for agent runs.
---
## What a rule does

A rule names a path pattern, how many approvals a run needs, and, optionally, who may give them:

| Pattern | Approvals | From |
|---|---|---|
| `payments/**` | 2 | any member |
| `infra/**` | 1 | alice or bob |
| `**/migrations/*.sql` | 1 | dba-lead |

A run **touches** a path when it synced a change to a file there. Every rule whose pattern matches one of those files applies, and every one must be met. A run that no rule matches needs one approval, as before.

An approval counts for a rule when:

- it comes from a member other than the person who synced the run;
- it is that member's newest decision on the run, and the run has not changed since;
- when the rule names approvers, it comes from one of them.

If every rule that applies names approvers and you are not one of them, the hub does not let you approve. Anyone may still reject.

## Where rules apply

- **The pull request check:** with [Require review](/docs/github#require-review) on, the `Grapim provenance (app)` check fails until every rule is met, and its summary names the rule and what is missing.
- **The run page** lists the rules that apply, which file matched, who has approved and who still needs to.
- **Approve from GitHub:** a click on the check's button follows the same rules.
- **Audit evidence:** each run lists the rules that apply now, and the rules in force when each decision was made.

## Writing patterns

- `**` matches any number of folders, also none. `*` matches any characters within one name. `?` matches one character.
- Patterns start at the repo root: `payments/**` matches `payments/stripe/charge.ts` but not `src/payments/x.ts`. Use `**/payments/**` to match a payments folder anywhere.
- A pattern ending in `/` means everything under it: `infra/` is `infra/**`.

## Who can use them

Owners add and remove rules in **Settings**, **Path rules**. Every member can read them. Path rules are on the **Governance** plan (a pilot during early access: [talk to us](/docs/support)). Without it, rules are kept but do not apply.
