---
title: Path rules
nav: Path rules
description: Let low-risk agent runs pass on their own and require named reviewers for sensitive paths. Like CODEOWNERS, for agent runs.
---
## Two kinds of rule

- **Automatic rules** approve a run when every file it changed matches one, for example `docs/**` or `**/*.test.*`. The check passes without anyone opening the run. The approval is recorded with the rule and the owner who set it, so someone is still accountable for it.
- **Review rules** require approvals for runs that change a sensitive path, for example `payments/**` needs 2 approvals.

Review rules always win. A run that changed `docs/setup.md` and `payments/charge.ts` needs the payments approvals, even though its docs change is covered. A run that matches no rule at all needs one approval from a member, as before. To review only sensitive paths, add an automatic rule for `**` and review rules for the paths that matter.

If a run changes again after it was approved by rule, the approval goes stale, and the rules are checked again on the next sync.

**Starter rules.** A team without rules can add a common set in one click: tests and docs automatic; `**/auth/**`, `**/payments/**`, `**/migrations/**`, `infra/**` and `.github/workflows/**` reviewed. Remove or change any of them after.

## What a review rule does

A review rule names a path pattern, how many approvals a run needs, and, optionally, who may give them:

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
