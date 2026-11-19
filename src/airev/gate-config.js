// The merge gate's settings (src/hub/github/merge-gate.js): what a team sets
// in Settings, Review, and the "gate" object of a repository's
// .grapim/review.json. Pure, so the engine's config check (config.js) and the
// hub share one definition.
//
//   mode            "off" | "suggest" | "auto-approve"
//   maxLines        a low-risk pull request changes at most this many lines (added + removed)
//   excludeAuthors  GitHub logins whose pull requests are never auto-approved
//   reviewers       GitHub logins (or org/team) to ask when CODEOWNERS names nobody
//
// The repository's file can only make the team's gate stricter (see
// stricterGate): it is read from the base commit, but it is still a file in
// the repository, and turning on auto-approval is the team owner's call.

export const GATE_MODES = Object.freeze(['off', 'suggest', 'auto-approve']);
export const GATE_DEFAULTS = Object.freeze({ mode: 'off', maxLines: 400, excludeAuthors: Object.freeze([]), reviewers: Object.freeze([]) });
export const GATE_LIMITS = Object.freeze({ minLines: 1, maxLines: 100_000, logins: 50 });
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const TEAM = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const validLogin = (s) => typeof s === 'string' && LOGIN.test(s.replace(/^@/, ''));
export const validReviewer = (s) => typeof s === 'string' && (LOGIN.test(s.replace(/^@/, '')) || TEAM.test(s.replace(/^@/, '')));

const fail = (message) => Object.assign(new Error(message), { code: 'gate_config' });

function logins(key, v, ok) {
  if (!Array.isArray(v)) throw fail(`"gate.${key}" must be a list of GitHub logins, like ["dependabot[bot]"].`);
  if (v.length > GATE_LIMITS.logins) throw fail(`"gate.${key}" has ${v.length} entries; at most ${GATE_LIMITS.logins} are allowed.`);
  const out = [];
  for (const s of v) {
    if (!ok(s)) throw fail(`${JSON.stringify(s)?.slice(0, 60)} in "gate.${key}" is not a GitHub login${key === 'reviewers' ? ' or org/team' : ''}.`);
    const clean = s.replace(/^@/, '');
    if (!out.some((x) => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
  }
  return Object.freeze(out);
}

// The "gate" object of .grapim/review.json -> a clean object with only the
// fields given. Throws an Error (code gate_config) that says what to change;
// config.js turns it into a ConfigError.
export function repoGate(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fail('"gate" must be an object, like {"mode": "suggest"}.');
  const known = ['mode', 'maxLines', 'excludeAuthors', 'reviewers'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) throw fail(`"gate" has a setting Grapim does not know: ${JSON.stringify(k).slice(0, 60)}. The settings are ${known.join(', ')}.`);
  const out = {};
  if ('mode' in raw) {
    if (!GATE_MODES.includes(raw.mode)) throw fail(`"gate.mode" must be "off", "suggest" or "auto-approve" (got ${JSON.stringify(raw.mode)?.slice(0, 40)}).`);
    out.mode = raw.mode;
  }
  if ('maxLines' in raw) {
    if (!Number.isSafeInteger(raw.maxLines) || raw.maxLines < GATE_LIMITS.minLines || raw.maxLines > GATE_LIMITS.maxLines) throw fail(`"gate.maxLines" must be a whole number from ${GATE_LIMITS.minLines} to ${GATE_LIMITS.maxLines}.`);
    out.maxLines = raw.maxLines;
  }
  if ('excludeAuthors' in raw) out.excludeAuthors = logins('excludeAuthors', raw.excludeAuthors, validLogin);
  if ('reviewers' in raw) out.reviewers = logins('reviewers', raw.reviewers, validReviewer);
  return Object.freeze(out);
}

const RANK = { off: 0, suggest: 1, 'auto-approve': 2 };

// team: the team's gate for this repository (mode already chosen for it);
// repo: repoGate() of the base commit's file, or null. The file may lower the
// mode and the size limit and add authors to exclude and reviewers to ask; it
// never raises anything the team set.
export function stricterGate(team, repo) {
  const t = { ...GATE_DEFAULTS, ...(team ?? {}) };
  if (!repo) return t;
  const lower = repo.mode && RANK[repo.mode] < RANK[t.mode] ? repo.mode : t.mode;
  const join = (a, b) => [...a, ...b.filter((x) => !a.some((y) => y.toLowerCase() === x.toLowerCase()))];
  return {
    mode: lower,
    maxLines: repo.maxLines ? Math.min(repo.maxLines, t.maxLines) : t.maxLines,
    excludeAuthors: join(t.excludeAuthors ?? [], repo.excludeAuthors ?? []),
    reviewers: join(t.reviewers ?? [], repo.reviewers ?? []),
  };
}
