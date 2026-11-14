# Grapim brand: C, "Clearance"

Chosen by the founder on 2026-11-14 from three directions (reports/brand-2026-11, research in research.md). For the regulated buyer: calm, institutional, unhurried. One deep hue, spruce, carries the brand and means "cleared". This file is the short spec; the tokens live in `ui/tokens.css` (shared by the hub, the review desk and the public site), and picture rules in `design/illustration.md`.

## Type

- **Public Sans** (SIL OFL, `ui/fonts/public-sans-latin.woff2`, variable 100-900) for all text and display. Headlines 640 weight, tracking -0.026em to -0.032em, line height 1.04 to 1.1. Body 16.5 px / 1.65 on the site, 14 px / 22 px in the hub. Wordmark 700, -0.005em.
- **IBM Plex Mono** (SIL OFL, `ui/fonts/ibm-plex-mono-{400,500,600}-latin.woff2`) for code, paths, commands, agent run names and line numbers. Nothing else.
- Two families, no more. Both self-hosted with `font-display: swap`; pages preload Public Sans and Plex Mono 400. Licences sit beside the files (`ui/fonts/LICENSE-*`).
- Small caps labels ("Works with", "Also in Grapim"): 12 px, 600, uppercase, +0.08em.

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | #0f5a50 spruce | #5ec2ad | the brand, primary buttons, links, focus, "cleared" |
| `--accent-bg` | #e1efeb | #12302a | selected rows, callouts, open badge |
| `--band` | #0b2a26 | #0b2a26 | the one deep band: hub sidebar, landing #where, share image |
| `--coral` | #e0533b | #e0533b | **Blocker only** (failing check mark, flagged line) |
| `--danger` | #c13c25 | #ff7a62 | danger text: Blocker titles, rejections, destructive buttons |
| `--warn-text` | #46597a slate | #a8badb | warnings and "needs review"; never amber |
| `--ok-text` | #0f6a4f | #6fd0a8 | OK, passed, approved, added lines |
| `--bg` / `--surface` | #f3f6f5 / #ffffff | #08110f / #0e1917 | mist neutrals, tinted toward spruce |
| `--text` / `-2` / `-3` | #0c1a18 / #43534f / #5a6a66 | #e5eeeb / #a9bab5 / #8b9d97 | |

- Neutrals are always the green-tinted mist set, never zinc or pure grey.
- Everything inside `.side`, `.sidebar` and `.where` uses the dark palette in both themes (tokens.css scopes it), so the band reads the same in light and dark.
- Report charts (`hub.css`): agent kinds spruce-teal, ochre, steel blue, brown, rose, olive; approved pale spruce, pending slate, rejected coral.
- Contrast: body text and line numbers at least 4.5:1 on their ground (diff line numbers use `--text-2` on the tinted gutter, about 7:1 light and 8:1 dark).

## Shape

- Radius 8 px (`--radius`) and 14 px (`--radius-lg`). Buttons and badges are pills (999 px). Cards 12 to 14 px; the hero stage 24 px.
- Shadows are soft and spruce-tinted (rgb(12 42 38 / …)), never black-on-white.

## The signature element: the clearance line

The last line of every review summary, "Your code was sent only to … Grapim received nothing.", set as a spruce seal with a check mark, in the one deep spruce band of the page. It states the product's promise as a fact the reader can check. Details in `design/illustration.md`.

## Voice

- Calm, full sentences. Say what happened and what it means, in plain words: "The run was asked to add pagination. This line deletes every stored email address."
- Facts before claims: name the provider, the region, the file, the line.
- No hype words ("AI-powered", "magic", "supercharge"), no stacked adjectives, no exclamation marks.

## Do

- Show the real product, rebuilt in HTML, with its real words.
- Keep spruce for the brand and for "cleared"; keep coral for Blocker.
- Use one deep band per page.

## Don't

- Indigo, violet, purple glows, or a second brand colour.
- Dot grids, isometric art, blobs, gradients behind headlines, dark glowing heroes.
- Amber for warnings (slate is the warning colour).
- Coral on anything but a Blocker, a rejection or a destructive action.
- A third font family, or Inter / JetBrains Mono on any page.
- A new logo: keep the current mark (the tilted square over the rounded square), in spruce or in the text colour.
