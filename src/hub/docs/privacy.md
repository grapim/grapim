<!--
Legal gaps for the founder to fill with a lawyer (this comment is not shown on the page):
- The legal name of the company that runs Grapim (the data controller), its registration number and its postal address. The page says "Grapim", "we" and "us" instead.
- Which data protection laws apply, and any EU or UK representative or data protection officer they require.
- Where the data is stored (the Railway region of the hub and its volume) and the legal basis for international transfers (for example Standard Contractual Clauses).
- The legal basis for each kind of processing, if GDPR applies (contract, legitimate interest, consent).
- A data processing agreement (DPA) for customers whose team data Grapim processes on their behalf. None is offered yet.
- The mailbox provider that receives email forwarded by Cloudflare Email Routing is not named.
- The minimum age (16) and the reply time (one month) are policy choices to confirm.
-->
---
title: Privacy Policy
nav: Privacy
description: What Grapim collects in each part of the product, why, where it is processed, how long it is kept, and how to ask about your data.
---
**Effective 15 November 2026**

This policy covers grapim.com, the hub at app.grapim.com, the `grapim` CLI, the Grapim GitHub App with cloud review, the Grapim Review GitHub Action, Ask Grapim, and email to grapim.com addresses. "Grapim", "we" and "us" mean the people who run these services.

## The short version

- **Grapim Review in your own CI** sends your code only to the model account you set up. Grapim receives nothing.
- **Cloud review** fetches a pull request's code into a temporary folder on our server, sends the changes to Anthropic for the review, and deletes the folder when the review ends. We keep a short record of each review, not the code.
- **The CLI** (`grapim`) has no telemetry. It keeps runs on your machine and sends them to the hub only when you run `grapim sync`.
- The website has no analytics, no advertising and no tracking cookies. We do not sell personal data.

## What we collect, and why

### The website

grapim.com loads no third-party scripts and sets no cookies. Our server logs each request's route, status code and how long it took. It does not log your IP address. It holds your IP address in memory for a short time to limit request rates, and does not store it. Our hosting provider, Railway, carries the connection and so handles your IP address to deliver the page.

If you pick a light or dark theme, your browser remembers it in its own local storage. That choice is never sent to us.

### Signing in to the hub

Sign-in uses GitHub and asks for no OAuth scopes. We read your public GitHub profile once: your GitHub id, login, name and avatar. We keep those to show who you are and which teams you belong to. The GitHub token is then dropped. We never get access to your repositories through your account.

We also keep the teams you create or join, your role in each, the invites you make, and your sessions. A session is a random id that we store only as a hash.

### The CLI and `grapim sync`

The CLI records agent runs on your machine. Nothing reaches Grapim until you run `grapim sync` (or `grapim folder` or `grapim mount`, which work with cloud workspaces). `grapim review --ai` sends your changes only to the model account in your own environment, never to Grapim. A sync sends the team's hub the runs, the first line of each prompt, the files agents touched, provenance notes, the repo's identity and the machine name. By default it also sends the contents of the files agents changed. A team owner can turn on **No code storage**, and then the hub keeps no file contents. [What Grapim stores](/docs/data-handling) lists every field in both modes.

We keep this to show your team its agent history, reviews and reports.

### The GitHub App

If a team owner installs the Grapim GitHub App, we keep which GitHub account it is installed on, who installed it, and which repositories it can see. The App reads pull request files and blame from GitHub to write its comment and check. It keeps the agent runs it found in each pull request, not the files. The 90-day history scan keeps each merged pull request's repo, number, title, author, merge time and the AI signals found.

### Cloud review

When a team owner turns on Cloud review, each pull request event starts one review:

1. The App's token for that installation fetches the base branch, the pull request's head and the Grapim notes (`refs/notes/grapim`) into a temporary folder on our server.
2. The changes, the pull request's title and description, and the text of issues it says it closes are sent to Anthropic's API, to Claude Opus 5.5, through Grapim's own Anthropic account.
3. The findings are posted to the pull request on GitHub as comments and a check.
4. The temporary folder is deleted when the review ends, whether it succeeded or failed.

For each review we keep: the repository owner and name, the pull request number, the head commit, the status, when it started and ended, how many findings and blockers it had, the tokens used, its cost against the team's monthly credit, and a short error message if it failed. We keep this to show the team its usage and to count the credit. We also keep whether Cloud review is on, and who last changed it.

### Grapim Review in your own CI

The Grapim Review GitHub Action runs on your GitHub runner. It sends your code only to the model endpoint you configure (the Anthropic API with your key, Amazon Bedrock, Google Vertex AI or Microsoft Foundry) and posts to GitHub with your workflow's token. Grapim's servers receive nothing: no code, no diffs, no findings, no telemetry. You do not need a Grapim account to use it.

### Ask Grapim

When you ask Ask Grapim a question, your question and the hub data it reads to answer (with your permissions, in your team only) are sent to Anthropic's API. We keep the conversation as it was sent to the model, the actions it prepared and what you decided, any rating you give an answer, and how many tokens each person used each day. We keep these so the conversation can continue, and to count the team's monthly credit. See [Ask Grapim](/docs/ask-grapim).

### Help and feedback, and email

The **Help and feedback** form in the hub keeps your GitHub login, the topic, your message and the page you wrote from, so we can answer you.

Email to [support@grapim.com](mailto:support@grapim.com), [privacy@grapim.com](mailto:privacy@grapim.com) and [hello@grapim.com](mailto:hello@grapim.com) is forwarded by Cloudflare Email Routing to the inbox of the people who run Grapim. We keep it to answer you.

### Integrations you connect

A team can connect its own services: a Slack incoming webhook for notifications, a Notion integration for a cloud workspace, or its own storage bucket for workspace files. We store their credentials encrypted, and send data to them only because you set them up. Those services handle that data under your own agreement with them.

### Billing

Grapim is free in early access, and we collect no payment details. When billing opens, payment will go through Stripe Checkout: Stripe collects your card and billing details directly, and they never reach our servers. We will keep only the Stripe customer and subscription ids, the plan, the number of seats and the subscription status.

## Where it is processed

These companies process data for us:

| Service | What for |
|---|---|
| Railway | Hosts the hub, its database, and the temporary folders of cloud reviews |
| Anthropic | Runs the model for cloud review and Ask Grapim |
| GitHub | Sign-in, and the GitHub App's access to the repositories you choose |
| Cloudflare | DNS for grapim.com, and forwarding email sent to grapim.com addresses |
| Stripe | Payments, once billing opens. Not used yet |

## Anthropic and model training

Anthropic's commercial terms say that Anthropic does not train its models on inputs and outputs sent through its API by commercial customers such as Grapim. This is Anthropic's commitment, not ours. Read [Anthropic's commercial terms](https://www.anthropic.com/legal/commercial-terms) for its exact wording. Grapim itself trains no models on your code or data.

## How long we keep it

- **Cloud review code**: deleted when the review ends. Only the review record above is kept.
- **Sessions**: 30 days, or until you sign out. The sign-in link between your browser and GitHub lasts 10 minutes.
- **Synced history**: kept for now. Your plan's history window hides older data, but it is not deleted yet, and leaving a team or removing a repo does not delete it. With No code storage on, a team owner can delete the team's stored file contents at any time.
- **Ask Grapim conversations, cloud review records and support messages**: kept for now. Nothing deletes them on a schedule yet.

To have any of this deleted, write to [privacy@grapim.com](mailto:privacy@grapim.com).

## Cookies and local storage

The public site sets no cookies. The hub sets only the cookies it needs to work:

| Cookie | What it does | How long |
|---|---|---|
| `grapim_session` | Keeps you signed in | 30 days, 2 hours in the live demo |
| `grapim_oauth` | Ties a GitHub sign-in to the browser that started it | 10 minutes |
| `grapim_embed` | Opens a review desk that a team embedded in another page, for that workspace only | As long as the team set for the link |

Over HTTPS their names start with `__Host-` or `__Secure-`. There are no analytics or advertising cookies, so there is no cookie banner. The site and the hub also keep your theme and a few interface choices in your browser's local storage. Those stay in your browser.

## Security

[Security and privacy](/docs/security) says how this data is protected, and what is not built yet.

## Your rights

You can ask us to show you the personal data we hold about you, to correct it, to delete it, to give you a copy, or to stop using it. Write to [privacy@grapim.com](mailto:privacy@grapim.com) from any address, and tell us your GitHub login so we can find your data. We reply within one month.

If you are a member of a team, the team's owners decide what the team syncs and connects. For data a team synced, we may ask its owners first. Depending on where you live, you can also complain to your data protection authority.

## Children

Grapim is a tool for people at work. It is not meant for children, and we do not knowingly collect data from anyone under 16.

## Changes

When we change this policy, we update this page and its effective date, and note the change in the [changelog](/changelog). If a change affects how we use data we already hold, we say so before it takes effect.

## Contact

Questions about privacy, or a request about your data: [privacy@grapim.com](mailto:privacy@grapim.com). Anything else: [support@grapim.com](mailto:support@grapim.com).
