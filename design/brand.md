# Grapim brand: monochrome

Chosen by the founder on 2026-11-14 from three directions (reports/brand-2026-11, research in research.md). Made black and white the same day (below). For the regulated buyer: calm, exact, unhurried. No brand hue: black, white and greys carry the brand, and the product supplies the only colour. This file is the short spec; the tokens live in `ui/tokens.css` (shared by the hub, the review desk and the public site), and picture rules in `design/illustration.md`.

## Type

- **Public Sans** (SIL OFL, `ui/fonts/public-sans-latin.woff2`, variable 100-900) for all text and display. Display (the landing hero, the closing line) 640 weight, 64 px at desktop down to 40 px at 375 px, tracking -0.04em, line height 1.02 to 1.04. Section titles 40 px, -0.03em. Body 16 px / 1.6 on the site, in --text-2, 14 px / 22 px in the hub. Wordmark 700, -0.005em.
- **IBM Plex Mono** (SIL OFL, `ui/fonts/ibm-plex-mono-{400,500,600}-latin.woff2`) for code, paths, commands, agent run names and line numbers. Nothing else.
- Two families, no more. Both self-hosted with `font-display: swap`; pages preload Public Sans and Plex Mono 400. Licences sit beside the files (`ui/fonts/LICENSE-*`).
- Small caps labels ("Works with", "Also in Grapim", footer column heads): 12 px, 500, uppercase, +0.08em, --text-3.

## Monochrome

Black and white replaced cobalt on 2026-11-14 (founder's call, the same day cobalt was chosen). The references were Vercel, Linear, OpenAI and Notion: a white page, near-black pill buttons, tight black display type, hairlines instead of boxes, and the real product as the picture. Grapim's own version keeps Public Sans and Plex Mono, the black band, and adds the broken path in #where. With no brand hue, the coral of a Blocker is the one colour on the first screen, which is the point: the product's finding is what the eye lands on.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` / `--surface` | #ffffff / #ffffff | #000000 / #0a0a0a | page and cards |
| `--surface-2` / `-3` | #fafafa / #f2f2f2 | #111111 / #1a1a1a | stage panels, file heads, code chips, the closing band |
| `--border` / `-strong` | #ebebeb / #d4d4d4 | #1f1f1f / #2e2e2e | hairlines, outline buttons |
| `--text` / `-2` / `-3` | #0a0a0a / #4d4d4d / #6b6b6b | #ededed / #a1a1a1 / #8f8f8f | pure greys, no tint |
| `--accent` | #0a0a0a | #ededed | primary buttons (black pill, white in dark), links, focus |
| `--accent-bg` | #f2f2f2 | #1a1a1a | selected rows, callouts, badges |
| `--band` | #0a0a0a | #0a0a0a | the one black band: hub sidebar, landing #where, share image |
| `--coral` | #e0533b | #e0533b | **Blocker only** (failing check mark, flagged line) |
| `--danger` | #c13c25 | #ff7a62 | danger text: Blocker titles, rejections, destructive buttons |
| `--warn-text` | #4d4d4d grey | #a1a1a1 | warnings and "needs review"; never amber, never a hue |
| `--ok-text` | #0f6a4f green | #6fd0a8 | OK, passed, approved, added lines (status, not brand) |

- Band surfaces: `--band-raise` #141414, `--band-head` #1c1c1c, borders #2e2e2e. Hover `--accent-hover` #2e2e2e light, #ffffff dark.
- Neutrals are pure greys. No blue, green or warm tint in any grey.
- The only colours: coral for a Blocker, danger red for destructive actions, green for passed, approved and added lines, the diff's red and green washes, and the agent data colours (`--a0` to `--a7`, report charts), which are data, never decoration.
- Syntax is quiet: keywords and names in the text colour, strings dark green, comments grey.
- Everything inside `.side`, `.sidebar` and `.where` uses the dark palette in both themes (tokens.css scopes it), so the band reads the same in light and dark.
- Report charts (`hub.css`): agent kinds black (white in dark), ochre, teal, brown, rose, olive; approved pale green, pending grey, rejected coral.
- Contrast (WCAG AA): light, --text on white 19.8:1, --text-2 8.5:1, --text-3 5.3:1 (5.1:1 on #fafafa, 4.8:1 on #f2f2f2); white on the black button 19.8:1; danger #c13c25 on white 5.3:1; strings #1a6e3a on #fafafa 6.0:1. Dark, --text on black 17.9:1, --text-2 8.1:1, --text-3 6.5:1 (6.1:1 on #0a0a0a); button text #0a0a0a on #ededed 16.9:1. In the band, --text-3 on #141414 5.7:1 and on #1c1c1c 5.3:1; the active sidebar item, white on #1c1c1c, 17.0:1. Coral #e0533b on white 3.8:1, used for marks and large type only.

## Shape

- Radius 8 px (`--radius`) and 14 px (`--radius-lg`). Buttons and badges are pills (999 px). Cards 12 to 14 px; the hero stage 24 px.
- Shadows are neutral and light (rgb(0 0 0 / 0.04 to 0.22)); hairlines do most of the separating.

## The signature: the broken path and the clearance line

The last line of every review summary, "Your code was sent only to … Grapim received nothing.", set white on black with a check mark, in the one black band of the page. Above it, one hairline runs from "Your GitHub" through "Your CI runner" to "Your model account" and stops; past the gap, ghosted, sits "Grapim, receives nothing". Both state the product's promise as a fact the reader can check. Details in `design/illustration.md`.

## Voice

- Calm, full sentences. Say what happened and what it means, in plain words: "The run was asked to add pagination. This line deletes every stored email address."
- Facts before claims: name the provider, the region, the file, the line.
- No hype words ("AI-powered", "magic", "supercharge"), no stacked adjectives, no exclamation marks.

## Do

- Show the real product, rebuilt in HTML, with its real words.
- Keep the brand black and white; keep green for OK, passed and approved only; keep coral for Blocker.
- Separate with 1 px hairlines, not boxed grey cards.
- Use one black band per page; a #fafafa band may separate the closing section.

## Don't

- Any brand hue: blue, cobalt, indigo, violet, purple glows. Tinted greys.
- Dot grids, isometric art, blobs, gradients behind headlines, dark glowing heroes.
- Amber or slate-blue for warnings (grey is the warning colour).
- Coloured gradients, glow blobs.
- Coral on anything but a Blocker, a rejection or a destructive action.
- A third font family, or Inter / JetBrains Mono on any page.
- A new logo: keep the current mark (the tilted square over the rounded square), in the text colour.
- Geist or Inter in place of Public Sans: the type is part of what makes this Grapim and not a copy.
