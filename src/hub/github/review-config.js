// A team's review settings for cloud review (Settings, Review): a few of the
// engine's own options (src/airev/config.js), chosen in the hub instead of in
// each repository's .grapim/review.json. Nothing here is an option the engine
// does not have.
//
// Precedence, per field: the engine's defaults, then the team's settings, then
// the repository's .grapim/review.json (read from the pull request's base
// commit), then the model the cloud pays for. A list in the file replaces the
// team's list, as it replaces the default one.
//
// Pure: no hub imports, so the review worker (cloud-review-worker.js) can use it.

import { compileGlob, DEFAULT_CONFIG, FAIL_ON, validateConfig } from '../../airev/config.js';

export const TEAM_REVIEW_KEYS = Object.freeze(['failOn', 'maxComments', 'ignore', 'instructions']);
export const TEAM_LIMITS = Object.freeze({ minComments: 1, maxComments: 50, globs: 50, globChars: 200, instructions: 2000 });

export class TeamConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamConfigError';
  }
}

const cleanText = (s) => String(s).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();

// The Settings, Review form -> the team's settings, or a TeamConfigError that
// says what to change. Every field is always saved: the form shows them all.
export function parseTeamForm(form = {}) {
  const failOn = form.failOn === 'blocker' ? 'blocker' : 'never';
  const raw = String(form.maxComments ?? '').trim();
  const maxComments = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!(maxComments >= TEAM_LIMITS.minComments && maxComments <= TEAM_LIMITS.maxComments)) {
    throw new TeamConfigError(`Comments per pull request must be a whole number from ${TEAM_LIMITS.minComments} to ${TEAM_LIMITS.maxComments}.`);
  }
  const lines = String(form.ignore ?? '').slice(0, 64 * 1024).split(/\r\n?|\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > TEAM_LIMITS.globs) throw new TeamConfigError(`Paths to skip has ${lines.length} lines; at most ${TEAM_LIMITS.globs} are allowed.`);
  const ignore = [];
  for (const l of lines) {
    if (l.length > TEAM_LIMITS.globChars) throw new TeamConfigError(`A path to skip is ${l.length} characters long; keep each under ${TEAM_LIMITS.globChars}.`);
    if (!compileGlob(l)) throw new TeamConfigError(`"${l.slice(0, 80)}" is not a path pattern Grapim understands. Use paths with * and **, like "src/**/*.sql", without ".." or backslashes.`);
    if (!ignore.includes(l)) ignore.push(l);
  }
  const instructions = cleanText(String(form.instructions ?? '').slice(0, 64 * 1024));
  if (instructions.length > TEAM_LIMITS.instructions) throw new TeamConfigError(`Review notes are ${instructions.length.toLocaleString('en-US')} characters long; keep them under ${TEAM_LIMITS.instructions.toLocaleString('en-US')}.`);
  return { failOn, maxComments, ignore, instructions };
}

// A stored (or handed over) team config -> only the known fields that are
// still valid. Anything else is dropped, never an error: the review must run.
export function cleanTeamConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  if (FAIL_ON.includes(v.failOn)) out.failOn = v.failOn;
  if (Number.isSafeInteger(v.maxComments) && v.maxComments >= TEAM_LIMITS.minComments && v.maxComments <= TEAM_LIMITS.maxComments) out.maxComments = v.maxComments;
  if (Array.isArray(v.ignore) && v.ignore.length <= TEAM_LIMITS.globs && v.ignore.every((p) => typeof p === 'string' && p.length <= TEAM_LIMITS.globChars && compileGlob(p))) out.ignore = [...v.ignore];
  if (typeof v.instructions === 'string' && v.instructions.length <= TEAM_LIMITS.instructions) out.instructions = cleanText(v.instructions);
  return out;
}

// What the form shows: the team's settings over the engine's defaults.
export function teamFormValues(stored) {
  const t = cleanTeamConfig(stored);
  return {
    failOn: t.failOn ?? DEFAULT_CONFIG.failOn,
    maxComments: t.maxComments ?? DEFAULT_CONFIG.maxComments,
    ignore: t.ignore ?? [...DEFAULT_CONFIG.ignore],
    instructions: t.instructions ?? DEFAULT_CONFIG.instructions,
  };
}

// The config a cloud review runs with. team: the team's settings (or null);
// repo: the repository's .grapim/review.json as parsed JSON, already checked
// with parseConfigText (or null when there is none); model: what the cloud
// pays for. A team that turned cloud review on expects every pull request
// reviewed, so the mode is "all" unless the repository's file picks one
// (cloud-review-worker.js says why).
export function mergeReviewConfig({ team = null, repo = null, model = null } = {}) {
  const r = repo && typeof repo === 'object' && !Array.isArray(repo) ? repo : {};
  return validateConfig({ review: 'all', ...cleanTeamConfig(team), ...r, ...(model ? { model } : {}) });
}
