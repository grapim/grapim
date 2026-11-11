# SaaS connectors (Notion first)

Agents change more than files: they edit Notion pages, Linear issues and CRM records. A connector maps one of those systems onto files under `saas/<connector>/` in a cloud workspace. From then on, an agent's change to SaaS data goes through the same ledger as a change to a file, so it is:

- **recorded**: who changed which page, line by line, in the runs list and in blame;
- **reviewable**: in the review desk, like any run;
- **undoable**: undoing the agent's run puts the previous content back in the SaaS too.

Notion is the first connector. This document is the design, what round-trips exactly, the limits, and how to add the next connector.

## How it works

```
Notion API  <--pull every 2 min-- connector --writes as run saas:notion-->  saas/notion/*.md
            --push block changes-          <--post-write callback--------  agent: /fs, MCP, WebDAV, undo, restore
```

- **Code**: the framework is `src/connectors/` (`sync.js` for the engine, `state.js` for the mapping, `queue.js` for rate limits); Notion is in `src/connectors/notion/` (`client.js`, `markdown.js`, `diff.js`, `index.js`); the hub wiring is `src/hub/connectors.js` and `src/hub/pages/connectors.js`. The engine's hook is `afterWrite` in `src/server/after-write.js`.
- **Mapping state**: kept per workspace, with the workspace's own Grapim state, in `.git/grapim/connectors/notion/state.json`. For each item it holds the Notion id, the file path, the remote version and the file's sha at the last sync, and the merge base (`base/<sha1>`, the content both sides last agreed on).
- **Versions**: a page's version is the sha1 of its file as rendered from Notion. Notion's `last_edited_time` is only precise to the minute, so it only decides which pages to look at again (anything edited since the last pull, with a 3-minute margin). The content decides whether a page changed.

### Pull (Notion to the workspace)

- Every 2 minutes per connected workspace, with ±20 s of jitter so workspaces do not pull in step, and on demand with **Sync now**.
- Scope: the pages and databases the integration was shared with in Notion, plus the rows of those databases. A page is listed with `POST /v1/search`, and a database's rows with `POST /v1/databases/{id}/query`.
- Each changed page is written as the run **`saas:notion`**, labelled Notion, one turn per pull, and approved automatically (like folder sync): the history shows what changed in Notion and when, and blame credits Notion's lines to Notion.
- If the file did not change here since the last sync, the new version replaces it. If it did (a push that failed earlier), the three versions are merged, as in folder sync.
- A page that leaves the scope (unshared, or moved to Notion's trash) is removed here as a recorded change, unless the file was edited here; then the file stays and is no longer linked. If Notion suddenly lists no pages at all, nothing is removed and the sync reports an error.
- Writes skip a file another agent holds (a claim) or is editing. They are tried again at the next pull.
- At most 4 pulls run at once on the hub (`MAX_PULLS`); the others wait their turn without opening their workspace.

### Push (an agent's write to Notion)

- The workspace engine calls a post-write callback after every recorded write or delete of a file: `/fs`, MCP `write_file` and `delete_file`, WebDAV, undo and restore. For a file under `saas/notion/`, the connector:
  1. reads the page and its blocks, and checks that the page is still at the version last synced;
  2. if it is, diffs the new Markdown against the page's blocks and applies the smallest set of block changes: unchanged blocks are left alone, a changed block of the same type is updated in place (`PATCH /v1/blocks/{id}`), new blocks are inserted after the block before them (`PATCH /v1/blocks/{id}/children` with `after`), and removed blocks are archived (`DELETE /v1/blocks/{id}`, which Notion keeps in its trash). Front matter changes become `PATCH /v1/pages/{id}` properties. The whole page is never replaced;
  3. reads the page again and records its new version.
- What happened comes back in the write's response: `saas: { status, message, ops }` on `/fs` and in the API's JSON, and as a line in MCP's tool result. `status` is `pushed`, `merged`, `conflict`, `archived`, `unchanged`, `not_linked`, `queued` or `error`. `queued`: a pull of this workspace was running and the push waited 20 s for it; the write is kept and the push runs as soon as the pull ends.
- **Conflicts**: if the page changed in Notion since the base, the three sides are merged (`git merge-file`, the same `mergeFile` as undo and folder sync).
  - A clean merge is written to the file first (as `saas:notion`), then pushed. The response's ETag is the merged file, so the agent re-reads it.
  - An overlapping edit pushes nothing. The file gets Notion's version, the agent's version is written next to it as `name (conflict from <agent> YYYY-MM-DD).md`, and the agent is told (MCP marks the result as an error). The copy is not linked to any page and is never pushed.
- **Deletes**: deleting a page's file moves the page to Notion's trash (`archived: true`). Undoing the delete takes it out again.
- **Undo**: undoing an agent's run writes the previous content back to the file, which triggers the same push. So undoing an agent that rewrote a page restores the page in Notion, and the undo is a recorded run like any other.
- A push that fails (Notion unreachable, a rate limit that outlasts the retries, an error from Notion) leaves the file as the agent wrote it, marks the item, and is retried at the next pull.
- A new file under `saas/notion/` that no page backs is kept but not sent: new pages are not created in Notion yet.

### Rate limits

Notion allows about 3 requests per second per integration. Each connection has a queue (`src/connectors/queue.js`): requests start at most 3 per second; a 429 is retried after its `Retry-After`, and 502, 503 and 504 with exponential backoff and jitter, up to 6 times. While one request waits out a 429, the whole queue waits.

## The file format

`saas/notion/<title-slug>--<first 8 hex characters of the page id>.md`, flat. The slug keeps letters and digits in any script (Chinese titles stay readable), lowercased, with everything else turned into `-`, at most 60 characters. If two pages share a slug and an id prefix, the second gets the full id. **The path is fixed when the page is first pulled**: renaming the page in Notion changes its title in the front matter, not the file name, so its history and blame stay on one file.

```markdown
---
# Notion page https://www.notion.so/...
Name: Ship the connector
Status: In progress
Tags: ["docs","notion"]
Due: 2026-11-11/2026-11-15
---

# Heading

A paragraph with **bold**, *italic*, `code`, ~~strike~~ and a [link](https://example.com).
```

- **Front matter**: the page's properties. A plain page has one, `title`. A database row has its columns, the title first and the others by name. Values are plain text, or JSON when needed (lists, quotes, numbers that should stay text). Writable from the file: title, text, number, select, status, multi-select, date (`start` or `start/end`), checkbox, URL, email, phone and relation (page ids). Shown but read-only: people, files, formula, rollup and unique id. Not shown: created and edited times and authors (they change on every edit). The `#` line is a comment.
- **Body**: Notion's blocks in this Markdown dialect.

| Notion block | Markdown |
|---|---|
| heading_1, heading_2, heading_3 | `#`, `##`, `###` |
| paragraph | text; lines that follow are soft line breaks in the same block |
| empty paragraph | `<br>` |
| bulleted_list_item | `- text` |
| numbered_list_item | `1. text` |
| to_do | `- [ ] text`, `- [x] text` |
| code | a fenced block with Notion's language (a bare fence is plain text) |
| quote | `> text` |
| callout | `> [!callout] 💡` and its text on the following `> ` lines |
| divider | `---` |
| anything else | a fenced `notion-block` with the block's JSON |
| children | indented under their block: by the marker's width for list items, 2 spaces otherwise |

Inline: `**bold**`, `*italic*` (or `_italic_` at word boundaries), `~~strike~~`, `` `code` ``, `[text](url)`, and `\` before any punctuation for a literal character.

## Round-trip guarantees

- **Exact**, tested in `test/connectors.test.js` for every supported block type:
  - blocks to Markdown to blocks gives the same blocks: type, text, bold, italic, strikethrough, inline code, links, to-do state, code language, callout emoji, nesting;
  - Markdown to blocks to Markdown gives the same text, for Markdown in the dialect above.
- **Never lost**: blocks the dialect does not express (images, files, tables, toggles, toggle headings, embeds, bookmarks, equations, columns, synced blocks, child pages and databases, ...) are kept as fenced `notion-block` JSON with their id. Left as they are, they are never touched in Notion. Their children are not shown and never changed. Volatile fields (signed file URLs that expire within the hour, timestamps, authors) are left out of the JSON, so they do not show as changes.
- **Untouched blocks are never rewritten.** A push only writes blocks whose Markdown changed, so what Markdown cannot express survives on every block the agent did not edit: underline, colours, comments, mentions, equations and block ids. On a block the agent did edit, it is rewritten from the Markdown, with these approximations:
  - underline and text colour are dropped from the edited block's text (the block's own colour is kept);
  - mentions (people, pages, dates) and inline equations become their plain text, and a page mention becomes a link;
  - spaces at the edge of bold or italic text move outside it (`**Note: **` becomes `**Note:** `), which looks the same;
  - a heading's line breaks become spaces; `####` and deeper become heading 3;
  - a code language Notion does not know becomes plain text (common aliases such as `js`, `ts`, `py` and `sh` are mapped);
  - a callout icon that is not an emoji is not shown; an emoji written in the file replaces it;
  - title and text properties are written as plain text.
- **Ids**: an edited block keeps its id. A block moved to another position is archived and created again (Notion's API cannot move blocks), so it gets a new id.

## Limits (v0)

- New pages are not created from new files, and a file renamed in the workspace is not a page renamed (rename the page by editing its title in the front matter).
- Notion's API cannot insert a block above the first block of a page or list. A new first block is inserted after the old first block, which is then created again below it and archived; its content is kept and its id changes. If that first block is one the dialect keeps as JSON (an image at the very top, say), the push is refused with a message.
- Pages over 10,000 blocks are not synced. Blocks nested deeper than 6 levels are kept whole as JSON.
- A database's own schema (adding columns) is not synced; only its rows.
- Children of a toggle, a table or another unsupported block are not shown.
- Pull is every 2 minutes, not instant: this version polls and does not use Notion's webhooks yet.
- Disconnecting keeps the files and their history; they are simply no longer synced. Reconnecting the same Notion workspace picks the mapping up again.
- Notion API version `2022-06-28` (databases, not the newer data sources).

## Security

- **The token**: the workspace owner pastes an internal integration secret. It is checked with Notion (`GET /v1/users/me`), then sealed with AES-256-GCM under a key of its own, derived from `HUB_SECRET` with HKDF (`grapim connector seal v1`, separate from the platform's key), and authenticated with the team, workspace and connector as additional data: copied into another workspace's row it does not open. It is never logged, never shown again (the page shows the integration's name), and only sent in the `Authorization` header to Notion. Rotating `HUB_SECRET` makes it unreadable: the page says to connect again.
- **No SSRF**: the client talks to one host, `https://api.notion.com/v1`, with paths built from fixed segments and ids checked to be Notion ids. Nothing a user types or a page contains becomes part of a URL. Redirects are refused, replies are capped at 16 MB, and each request has 30 s.
- **Untrusted content**: everything from Notion (titles, text, the integration's name, error messages) is data. The hub escapes it in pages; files are served as data, never as a page; titles only reach file names through the slug.
- **Confinement**: the framework checks every path a connector names: it must be a `.md` file directly in `saas/<name>/`. Then `resolvePath` and the sensitive-file guard check it like any agent's write. A connector cannot write anywhere else, nor a file that runs code.
- **Path scopes**: agents reach these files through `/fs`, MCP and WebDAV like any other, so a token's folder rules (`src/scope.js`) apply to them: a token limited to `docs/**` cannot read or write `saas/notion/`.
- **Who**: only team owners connect, test, sync and disconnect (the routes are owner-only and CSRF-checked). Members see the status.
- **Notion's side**: an internal integration sees only the pages shared with it. Give it the capabilities it needs (read, update and insert content), nothing more.

## Adding the next connector

A connector is an object with `describe()`, `test()`, `list()`, `pull(since)`, `push(entry, content, baseVersion)`, `remove(entry)` and `restore(entry)` (see `src/connectors/index.js` for the exact shapes). `createSync` does the rest the same way for all of them: the mapping, the ledger run `saas:<name>`, merges and conflict copies, path checks, undo. To add one:

1. Write `src/connectors/<name>/`: a client for the service's API on its fixed host, with the shared queue for rate limits; a converter between its records and files; a diff that applies the smallest change.
2. Register it in `CONNECTORS` in `src/connectors/index.js` (and a token check in `src/hub/connectors.js`); the workspace page shows its card.
3. Add a fake of its API to the tests, and the same tests as Notion's: round trips, pull as an approved run, minimal pushes, merge and conflict, undo, 429, confinement.

Notes for the next ones:

- **Google Docs**: OAuth rather than a pasted token (the hub needs a Google client and a refresh token, sealed the same way). A document is one file; `documents.batchUpdate` takes index-based edits, so the diff must work from the end of the document backwards. Comments and suggestions are kept, like Notion's unsupported blocks. Drive's `modifiedTime` and the revision id give a better version than a content hash.
- **Linear**: a personal API key or OAuth; GraphQL. An issue is a file (`saas/linear/<team>/<KEY-123>--<slug>.md`) with title, state, assignee, labels and priority as front matter and the description as the body. Comments are append-only, so keep them read-only in the file. Linear has webhooks: they can replace polling.
- **Salesforce**: OAuth (connected app), REST and SOQL. A record is a file per object type (`saas/salesforce/Opportunity/<Id>.md` or `.yaml`, fields only). Use `LastModifiedDate` and `SystemModstamp` for versions and the `If-Unmodified-Since` header on updates for the conflict check. Respect field-level security: never write a field the user cannot edit. Bulk API limits are per org and per day, so the queue needs a daily budget too.

## 給創辦人：Notion 連接設定（繁體中文）

這個功能讓 agent 改 Notion 的內容時，就跟改檔案一樣：每一次修改都有紀錄、可以審查、可以一鍵復原。

### 一次性設定（約 3 分鐘）

1. 打開 Notion 的整合頁面：<https://www.notion.so/profile/integrations>，按 **New integration**。
2. 選你的 Notion workspace，類型保持 **Internal**，取個名字（例如 `Grapim`），儲存。
3. 在 **Capabilities** 勾選 **Read content**、**Update content**、**Insert content**，其他不用勾。
4. 複製 **Internal Integration Secret**（以 `ntn_` 開頭，舊的整合是 `secret_`）。
5. 回到 Notion，打開每一個要讓 agent 處理的頁面或資料庫，點右上角 **•••** → **Connections** → 選剛剛建立的整合。子頁面會一起分享。
6. 到 Grapim hub：**Workspaces** → 選一個 workspace → **Connect Notion** 卡片，貼上 secret，按 **Test and connect**。
7. 一分鐘內，分享的頁面就會出現在 workspace 的 `saas/notion/` 資料夾，一頁一個 Markdown 檔。

### 之後會發生什麼

- 每 2 分鐘自動從 Notion 拉一次最新內容，也可以按 **Sync now** 立刻同步。Notion 上的改動在 Grapim 的歷史裡會顯示為 **Notion** 這個 run（自動核准）。
- agent 透過 `/fs`、MCP 或網路磁碟（WebDAV）改 `saas/notion/` 裡的檔案時，Grapim 只更新有改到的區塊，不會整頁覆蓋。
- 如果同一頁在 Notion 上也剛被人改過：改的地方不衝突就自動合併；衝突的話不會送出，原檔放 Notion 的版本，agent 的版本另存成「(conflict from …)」的副本，並在回應裡告訴 agent。
- 要撤銷某個 agent 對 Notion 的修改：在 review desk 找到那個 run，按 **Undo**，Notion 上的內容就會改回去。
- 刪掉檔案會把該頁移到 Notion 的垃圾桶；復原那次刪除就會把頁面拿回來。

### 安全

- secret 加密儲存（AES-256-GCM，綁定這個 workspace），不會顯示、不會寫進 log，只會送到 `api.notion.com`。
- 整合只看得到你在 Notion 裡分享給它的頁面。
- 只有 team owner 可以連接、測試、同步和中斷連接。
- 按 **Disconnect** 就立刻停止同步；檔案和歷史紀錄會留在 workspace 裡。

### 目前的限制

- 在 `saas/notion/` 新增檔案不會在 Notion 建立新頁面。
- 圖片、表格、toggle 等區塊會以 `notion-block` JSON 保留，agent 看得到但不建議直接改。
- 改到的區塊上，底線和文字顏色會消失；沒改到的區塊完全不動。
