---
title: Slack notifications
nav: Slack notifications
description: Post to a Slack channel when agent runs wait for approval and when the Grapim check fails on a pull request.
---
## What gets posted

- **Runs waiting for approval:** one message at most every 15 minutes, listing each new agent run nobody has approved yet, with a link to its review page. Each run is listed once.
- **A failed check:** when the `Grapim provenance (app)` check fails on a pull request, once per pushed commit, with a link to the pull request.

## Set it up

You need to be an owner of the team.

1. In Slack, create an app for your workspace, turn on **Incoming Webhooks**, and add a webhook to the channel you want. Slack's guide: [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).
2. Copy the webhook URL. It starts with `https://hooks.slack.com/services/`.
3. In the hub, open **Settings**, **Notifications**, paste it and choose **Save webhook**, then **Send a test message**.

## How the URL is kept

The webhook URL lets anyone who has it post to your channel, so the hub treats it as a secret:

- only `https://hooks.slack.com/services/…` addresses are accepted, and the hub never follows a redirect, so it sends nothing anywhere else;
- it is stored encrypted, and the settings page shows only its last four characters;
- if Slack answers that the webhook was revoked or the channel is gone (403, 404 or 410), notifications stop and the settings card says why. Save a working URL to turn them back on.

Notifications work on every plan.
