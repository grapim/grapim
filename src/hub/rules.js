// Sensitive path rules (research/core-features-2026-11.md, feature 4): like
// CODEOWNERS, but for agent runs. An owner writes rules such as
//
//   payments/**   needs 2 approvals
//   infra/**      needs 1 approval from alice or bob
//
// A run "touches" a path when it synced a change to it (h_changes). Every
// rule whose pattern matches one of those paths applies, and every one must
// be met: at least `approvals` members other than the run's owners, each
// with a current approval (their own newest decision on the run is an
// approval and it saw the run's newest change), and, when the rule names
// approvers, only those members count. A run that no rule matches needs one
// approval, as before.
//
// Rules are a Governance feature: without the plan they are kept but inert.
// Every query is scoped by team id.

export const RULES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_path_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  pattern    TEXT NOT NULL,
  approvals  INTEGER NOT NULL DEFAULT 1,
  approvers  TEXT NOT NULL DEFAULT '[]',     -- JSON [user id]; [] = any member
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hub_path_rules_team ON hub_path_rules(team_id, id);
`;

export const MAX_RULES = 50;
export const MAX_APPROVALS = 5;
const MAX_PATHS = 5000;
const PATTERN = /^[A-Za-z0-9_.\-/*?@+ ]{1,200}$/;

// A path pattern -> RegExp over repo-relative paths ("src/a.js").
//   **  any number of directories (also none), *  any characters but "/",
//   ?  one character but "/". A trailing "/" means everything under it. A
//   leading "/" is ignored: patterns always start at the repo root, so
//   "**/payments/**" matches a payments folder anywhere.
export function compilePattern(pattern) {
  let p = String(pattern ?? '').trim().replace(/^\/+/, '');
  if (!p || !PATTERN.test(p) || p.includes('..')) return null;
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') {
        i++;
        re += '(?:[^/]*/)*';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const validPattern = (p) => compilePattern(p) !== null;

const parseIds = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter(Number.isSafeInteger) : [];
  } catch {
    return [];
  }
};

export class PathRules {
  constructor({ db, now }) {
    this.db = db;
    this.now = now;
    db.exec(RULES_SCHEMA);
  }

  list(teamId) {
    return this.db
      .prepare('SELECT * FROM hub_path_rules WHERE team_id = ? ORDER BY id')
      .all(teamId)
      .map((r) => ({ id: r.id, pattern: r.pattern, approvals: r.approvals, approvers: parseIds(r.approvers), created_by: r.created_by, created_at: r.created_at }));
  }

  // Throws { code: 'bad_request' } with a message a person can act on.
  add(teamId, { pattern, approvals = 1, approvers = [] }, userId) {
    const fail = (message) => Object.assign(new Error(message), { code: 'bad_request' });
    const p = String(pattern ?? '').trim();
    if (!validPattern(p)) throw fail('Write a path pattern such as payments/** or **/migrations/*.sql (letters, digits, / . - _ * ?).');
    const n = Number(approvals);
    if (!Number.isInteger(n) || n < 1 || n > MAX_APPROVALS) throw fail(`Approvals must be a whole number from 1 to ${MAX_APPROVALS}.`);
    const members = new Set(this.db.prepare('SELECT user_id FROM members WHERE team_id = ?').all(teamId).map((r) => r.user_id));
    const ids = [...new Set(approvers.map(Number))].filter((id) => members.has(id));
    if (approvers.length && !ids.length) throw fail('Pick approvers from the team.');
    if (ids.length && ids.length < n) throw fail(`The rule needs ${n} approvals but names ${ids.length} approver${ids.length === 1 ? '' : 's'}. Name at least ${n}.`);
    if (this.db.prepare('SELECT COUNT(*) AS n FROM hub_path_rules WHERE team_id = ?').get(teamId).n >= MAX_RULES) throw fail(`A team can have at most ${MAX_RULES} rules.`);
    const r = this.db
      .prepare('INSERT INTO hub_path_rules (team_id, pattern, approvals, approvers, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(teamId, p.replace(/^\/+/, ''), n, JSON.stringify(ids), userId, this.now());
    return Number(r.lastInsertRowid);
  }

  remove(teamId, id) {
    return this.db.prepare('DELETE FROM hub_path_rules WHERE team_id = ? AND id = ?').run(teamId, Number(id)).changes > 0;
  }

  // The paths a run changed in the team's repos.
  paths(teamId, repoIds, run) {
    const out = new Set();
    const q = this.db.prepare('SELECT DISTINCT path FROM h_changes WHERE team_id = ? AND repo_id = ? AND run = ? LIMIT ?');
    for (const repoId of repoIds) for (const r of q.all(teamId, repoId, run, MAX_PATHS)) out.add(r.path);
    return out;
  }

  // The rules that apply to these paths: [{ ...rule, path (the first match) }].
  matching(teamId, paths, rules = this.list(teamId)) {
    const out = [];
    for (const rule of rules) {
      const re = compilePattern(rule.pattern);
      if (!re) continue;
      for (const p of paths) {
        if (re.test(p)) {
          out.push({ ...rule, path: p });
          break;
        }
      }
    }
    return out;
  }

  // Whether the run's current approvals meet every rule that applies.
  // approvals: [{ user_id, login }] (src/hub/reviews.js approvals()).
  // -> { rules: [{ id, pattern, path, approvals, approvers: [{ id, login }], have: [login], need, ok }], ok }
  evaluate(teamId, repoIds, run, approvals, rules = this.list(teamId)) {
    if (!rules.length) return { rules: [], ok: true };
    const applied = this.matching(teamId, this.paths(teamId, repoIds, run), rules);
    const loginOf = this.db.prepare('SELECT login FROM users WHERE id = ?');
    const out = applied.map((rule) => {
      const listed = new Set(rule.approvers);
      const counted = approvals.filter((a) => !listed.size || listed.has(a.user_id));
      return {
        id: rule.id,
        pattern: rule.pattern,
        path: rule.path,
        approvals: rule.approvals,
        approvers: rule.approvers.map((id) => ({ id, login: loginOf.get(id)?.login ?? `user ${id}` })),
        have: counted.map((a) => a.login ?? `user ${a.user_id}`),
        need: Math.max(0, rule.approvals - counted.length),
        ok: counted.length >= rule.approvals,
      };
    });
    return { rules: out, ok: out.every((r) => r.ok) };
  }

  // Whether `userId`'s approval can count: false when every rule that
  // applies names approvers and none of them is this person.
  mayApprove(teamId, repoIds, run, userId, rules = this.list(teamId)) {
    const applied = this.matching(teamId, this.paths(teamId, repoIds, run), rules);
    const listed = applied.filter((r) => r.approvers.length);
    if (!listed.length || listed.length < applied.length) return { ok: true, rules: applied };
    return { ok: listed.some((r) => r.approvers.includes(userId)), rules: applied };
  }
}

// One line for the check summary, Slack or the run page.
export function ruleText(r) {
  const who = r.approvers.length ? ` from ${r.approvers.map((a) => a.login).join(', ')}` : '';
  return `${r.pattern} needs ${r.approvals} approval${r.approvals === 1 ? '' : 's'}${who}; ${r.have.length ? `has ${r.have.length} (${r.have.join(', ')})` : 'has none'}`;
}
