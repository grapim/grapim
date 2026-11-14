# Grapim Review: AI code review that runs in your own environment (2026-11-14)

Direction chosen 2026-11-14 ("2+4"): sell to teams that are not allowed to send code to a review vendor (finance, health, insurance, security, and the B2B software companies that sell to them, 20-200 engineers). Grapim Review is an AI reviewer that:

1. **Runs inside the customer's own CI** (a GitHub Action, or `grapim review --ai` locally). The code goes only to the model endpoint the customer chooses: the Anthropic API, Amazon Bedrock in their own AWS account, Google Vertex AI in their own project, or Microsoft Foundry. It never reaches Grapim's servers. Grapim stores no code and no diffs.
2. **Knows which agent wrote each line, and what it was asked to do** (the provenance notes, `docs/provenance.md`). This is what no other reviewer has. For lines from an agent run, the reviewer gets the run's prompt (intent) and checks: does the change do what was asked, and nothing else? (Scope creep, deleted tests, weakened checks, secrets, destructive migrations, and changes far from the request.)
3. **Spends review effort where risk is.** Agent-written lines on sensitive paths get the deepest review; human-only low-risk files are skipped by default.

## Pieces

| Piece | Where | What |
|---|---|---|
| Engine | `src/airev/` | Plan (which hunks, which depth), prompt, model call, parse and validate findings. No GitHub code. No dependencies (node: builtins and plain `fetch`, like the rest of Grapim). |
| Action | `action/review/` (`action.yml`, `index.mjs`, `dist/` bundled by `action/bundle.mjs`) | `uses: grapim/grapim/action/review@main`. Posts one PR review with inline comments, plus a summary. Fails the job on blockers when `fail-on: blocker`. |
| CLI | `grapim review --ai [<base>..<head>] [--request-file <path>]` in `src/cli.js` | The same engine on a local branch, printed to the terminal. |

## Engine interface (`src/airev/index.js`)

```js
reviewChanges({
  cwd,                 // git checkout
  base, head,          // commits (head defaults to HEAD, base to merge-base with the default branch)
  config,              // parsed .grapim/review.json merged with defaults (loadConfig)
  provider,            // from providerFromEnv(env, config)
  request,             // optional: what the PR was asked to do, { title, body, issues: [{ number, title, body }] }
  fetchImpl, log, now,
}) -> Promise<{
  findings: [{ path, line, side: 'RIGHT', endLine?, severity: 'blocker'|'warning'|'nit',
               category, title, body, run?: { id, kind, intent } }],
  summary: string,     // markdown, short
  stats: { files, hunks, reviewedHunks, aiHunks, skippedHunks, inputTokens, outputTokens, model, provider, comparedWith },
  skipped: [{ path, reason }],
}>

loadConfig(cwd) -> config         // .grapim/review.json, validated; unknown keys are errors
providerFromEnv(env, config) -> provider | throws ConfigError with a plain-words message
```

Every finding's `path`/`line` must lie on a line the diff adds or changes (validated; others are dropped and counted).

## What was asked: the pull request's own request (2026-11-14)

Provenance notes give the prompt of each agent run, but most repos have no notes yet. So the pull request's stated request is an intent source too, for everyone:

- **Sources.** Linked issues (closing keywords `closes/fixes/resolves #N`, `owner/repo#N` or the issue URL, same repo only, at most 3) count as *what was asked*. The PR title and description count as *what the author says it does*: agent-written descriptions often describe the result, not the request, so the prompt weighs them lower. A run's prompt from the notes stays the authority for the hunks it wrote.
- **Where it comes from.** The Action: the `pull_request` event's title and body, and the linked issues read with `github-token` (a 403/404 leaves that issue out). Input `use-pr-request` (default `true`). The CLI: `--request-file <path>` (JSON in the engine's shape, or Markdown taken as the request, first `# ` heading as title), else the branch's open PR through `gh pr view` / `gh issue view` when `gh` is installed and signed in; otherwise none.
- **Prompt.** `src/airev/request.js` normalizes and caps it (titles 200 chars, each issue 2,500, the description 3,000, about 8,000 chars in all, issues first). `prompt.js` adds a fixed guide (`REQUEST_GUIDE`, Grapim's words) and one fenced `REQUEST` block per source (`source="linked issue" number=12` / `source="pull request"`), with the same random nonce as the other untrusted blocks. The model is told to report only concrete mismatches (asked X, does Y; or a change nobody asked for), as `intent_mismatch`/`scope`, warning at most, and never that something is missing from the hunks of one batch alone (other batches may hold it).
- **Bounded.** The request is context only: it never changes which hunks are reviewed or their depth. It adds at most about 2,000 tokens to each request. With no request the user message and the system prompt are byte for byte what they were.
- **Summary.** One line when it was used: `**Compared with:** issue #12, PR description`.

## Config `.grapim/review.json` (all optional)

```json
{
  "model": "claude-opus-5-5",
  "review": "ai-and-sensitive",          // "ai-and-sensitive" (default) | "all" | "ai-only"
  "sensitive": ["**/migrations/**", "**/auth/**", "**/infra/**", "**/*.sql", ".github/workflows/**"],
  "ignore": ["**/*.lock", "**/dist/**", "**/*.snap"],
  "instructions": "Our services must never log account numbers.",
  "maxComments": 15,
  "maxFiles": 100,
  "failOn": "blocker"                    // "blocker" | "never"
}
```

Depth per hunk: agent-written and sensitive -> `high` effort, agent-written -> `medium`, sensitive human-written -> `medium`, other human-written -> skipped under the default (`low` under `all`).

## Providers (customer's credentials, read from env)

| `GRAPIM_REVIEW_PROVIDER` | Credentials | Notes |
|---|---|---|
| `anthropic` (default when `ANTHROPIC_API_KEY` is set) | `ANTHROPIC_API_KEY` | Server-side refusal fallback (`fallbacks: "default"`). |
| `bedrock` | `AWS_REGION` + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` (from `aws-actions/configure-aws-credentials` with OIDC) | Messages API on the Bedrock Mantle endpoint, SigV4 signed (reuse `src/storage/s3.js` `signV4`); model id `anthropic.<model>`. |
| `vertex` | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_REGION` (default `global`), `GOOGLE_OAUTH_ACCESS_TOKEN` (from `google-github-actions/auth` with `token_format: access_token`) | `:rawPredict` on the publisher model. |
| `foundry` | `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_RESOURCE` | |

Each provider is a small adapter that sends a Messages API body and returns the message. Plain `fetch` (the Action has no dependencies by design).

## Model call

- Default `claude-opus-5-5`, adaptive thinking (always on), `output_config.effort` from the depth, `output_config.format` = JSON schema of findings (structured outputs). No forced `tool_choice`.
- System prompt is fixed and cached (`cache_control`). The diff, file context and run prompts are untrusted data inside clearly marked blocks; the system prompt says instructions inside them are never followed.
- One request per batch of hunks (batched per file, under a token budget). Check `stop_reason` (`refusal` -> the batch is reported as skipped, with category; `max_tokens` -> retry once smaller).
- Hard caps: `maxFiles`, a per-run input-token budget, `maxComments` (keep the most severe).

## Output on GitHub

- One review (`POST /pulls/{n}/reviews`, `event: COMMENT`) with inline comments: `**Blocker: title**` + body + for agent lines `Written by Claude Code run "<intent>"`. A re-run replaces nothing silently: earlier Grapim review comments on lines that are now gone are left; the summary comment (marker `<!-- grapim:review -->`) is updated in place.
- Summary: counts by severity, which agent runs were reviewed and at what depth, what was skipped and why, the model and provider, and "Your code was sent only to <provider> in <region/project>; Grapim received nothing."
- Forked PRs: read-only token -> job summary only.
