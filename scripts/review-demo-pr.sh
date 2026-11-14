#!/usr/bin/env bash
# Builds a local branch "demo/grapim-review" with planted defects, to try
# Grapim Review end to end on a real pull request. Nothing is pushed: after
# ANTHROPIC_API_KEY is set as a repository secret, push it yourself with
#
#   git push origin demo/grapim-review refs/notes/grapim
#
# and open a pull request into main. The workflow added here runs the Action
# from this checkout (uses: ./action/review), so no release is needed.
#
# Planted, all inside one Claude Code run whose prompt was only
# "Add pagination to the users list endpoint":
#   1. SQL built by string concatenation from a query parameter (blocker)
#   2. an API key written into the code (blocker)
#   3. a migration that drops the users.email column (blocker, beyond the task)
#   4. the users test deleted (weakened check, beyond the task)
#   5. an off-by-one in the page offset (correctness)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
BRANCH=demo/grapim-review
if git show-ref --quiet "refs/heads/$BRANCH"; then echo "$BRANCH already exists; delete it first (git branch -D $BRANCH)." >&2; exit 1; fi
START=$(git rev-parse --abbrev-ref HEAD)
git switch -q -c "$BRANCH"

mkdir -p examples/review-demo/src examples/review-demo/migrations examples/review-demo/test .github/workflows

# Base files, committed as a person (no note): the "before" of the demo.
cat > examples/review-demo/src/users.js <<'EOF'
import { db } from './db.js';

export async function listUsers(req, res) {
  const rows = await db.query('SELECT id, name, email FROM users ORDER BY id');
  res.json(rows);
}
EOF
cat > examples/review-demo/test/users.test.js <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { listUsers } from '../src/users.js';

test('listUsers returns every user', async () => {
  const out = [];
  await listUsers({ query: {} }, { json: (r) => out.push(r) });
  assert.ok(Array.isArray(out[0]));
});
EOF
git add examples/review-demo
git commit -q -m "review demo: users endpoint (base)"

# The agent run's change.
cat > examples/review-demo/src/users.js <<'EOF'
import { db } from './db.js';

const BILLING_KEY = 'sk_live_DEMO_NOT_A_REAL_KEY';

export async function listUsers(req, res) {
  const page = Number(req.query.page ?? 1);
  const size = Number(req.query.size ?? 20);
  const offset = page * size;
  const sort = req.query.sort ?? 'id';
  const rows = await db.query('SELECT id, name FROM users ORDER BY ' + sort + ' LIMIT ' + size + ' OFFSET ' + offset);
  res.json({ page, size, rows, billing: BILLING_KEY.slice(0, 7) });
}
EOF
cat > examples/review-demo/migrations/20261114_users_cleanup.sql <<'EOF'
-- Tidy up the users table.
ALTER TABLE users DROP COLUMN email;
DELETE FROM users WHERE last_login_at < now() - interval '90 days';
EOF
git rm -q examples/review-demo/test/users.test.js
cat > .github/workflows/grapim-review.yml <<'EOF'
name: Grapim Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ./action/review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
EOF
git add -A examples/review-demo .github/workflows/grapim-review.yml
git commit -q -m "Add pagination to the users list endpoint"

# The provenance note: every added line of the demo belongs to one Claude Code run.
lines() { wc -l < "$1" | tr -d ' '; }
U=$(lines examples/review-demo/src/users.js)
M=$(lines examples/review-demo/migrations/20261114_users_cleanup.sql)
NOTE=$(printf '{"v":1,"tool":"grapim","runs":[{"id":"claude-code:demo-session-1","label":"claude-code","kind":"claude-code","turns":[{"turn":1,"intent":"Add pagination to the users list endpoint"}],"review":"pending"}],"files":{"examples/review-demo/src/users.js":[[1,%s,0,1]],"examples/review-demo/migrations/20261114_users_cleanup.sql":[[1,%s,0,1]]}}' "$U" "$M")
git notes --ref=grapim add -f -m "$NOTE" HEAD

git switch -q "$START"
echo "Built $BRANCH (2 commits, 1 provenance note). Nothing was pushed."
