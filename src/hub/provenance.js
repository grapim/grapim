// Provenance notes on the hub (docs/provenance.md section 3).
//
// `grapim sync` sends `provenance: [{ commit, note }]` (at most 200 per batch)
// and `repo.github` ("github.com/owner/name", from the origin remote). Notes
// are parsed and validated with the client's own parser, stored normalised in
// h_provenance, keyed by team: every read below filters on team_id, like
// every other synced table.
//
// provenanceFor(db, team, repoId, shas) and repoByGitHub(db, team, fullName)
// are what the GitHub App and the reports read.

import { NoteError, parseNote, serializeNote, MAX_NOTE_BYTES } from '../provenance/note.js';
import { HttpError, badRequest } from './http.js';

export const MAX_PROVENANCE = 200;
const SHA = /^[0-9a-f]{40}$/;
const GITHUB = /^github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

// Same as src/hub/reports/index.js: whichever module opens the db first creates it.
export const PROVENANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS h_provenance (
  team_id     TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  note_json   TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id, commit_sha)
);
CREATE INDEX IF NOT EXISTS h_provenance_received ON h_provenance(team_id, received_at);
`;

// "github.com/owner/name" -> "owner/name", or null if absent. Throws on a bad value.
export function parseGitHub(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? GITHUB.exec(v) : null;
  if (!m || m[2] === '.' || m[2] === '..') throw badRequest('repo.github must look like github.com/owner/name.');
  return `${m[1]}/${m[2]}`;
}

// Validates body.provenance. Returns [{ commit, note_json }] (note re-serialised).
export function parseProvenance(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest('provenance must be an array.');
  if (v.length > MAX_PROVENANCE) throw new HttpError(413, 'too_large', `At most ${MAX_PROVENANCE} provenance notes per batch.`);
  const seen = new Set();
  return v.map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw badRequest(`provenance[${i}] must be an object.`);
    if (typeof p.commit !== 'string' || !SHA.test(p.commit)) throw badRequest(`provenance[${i}].commit must be a 40-character commit sha.`);
    if (seen.has(p.commit)) throw badRequest(`provenance[${i}]: commit ${p.commit} is in this batch twice.`);
    seen.add(p.commit);
    if (typeof p.note !== 'string') throw badRequest(`provenance[${i}].note must be the note text.`);
    if (Buffer.byteLength(p.note) > MAX_NOTE_BYTES) throw new HttpError(413, 'too_large', `provenance[${i}].note is over ${MAX_NOTE_BYTES} bytes.`);
    let note;
    try {
      note = parseNote(p.note);
    } catch (err) {
      if (err instanceof NoteError) throw badRequest(`provenance[${i}]: ${err.message}`);
      throw err;
    }
    return { commit: p.commit, note_json: serializeNote(note) };
  });
}

export const provenanceBytes = (list) => list.reduce((n, p) => n + 64 + p.commit.length + Buffer.byteLength(p.note_json), 0);

// Inside the ingest transaction. Upserts the notes (a re-recorded note
// replaces the old one) and returns { stored, bytes } where bytes is what the
// team's storage grew by.
export function storeProvenance(db, teamId, repoId, list, now) {
  const get = db.prepare('SELECT note_json FROM h_provenance WHERE team_id = ? AND repo_id = ? AND commit_sha = ?');
  const put = db.prepare(
    `INSERT INTO h_provenance (team_id, repo_id, commit_sha, note_json, received_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, repo_id, commit_sha) DO UPDATE SET note_json = excluded.note_json, received_at = excluded.received_at
     WHERE h_provenance.note_json <> excluded.note_json`,
  );
  let stored = 0;
  let bytes = 0;
  for (const p of list) {
    const old = get.get(teamId, repoId, p.commit);
    const n = put.run(teamId, repoId, p.commit, p.note_json, now).changes;
    if (!n) continue;
    stored++;
    bytes += old ? Math.max(0, Buffer.byteLength(p.note_json) - Buffer.byteLength(old.note_json)) : 64 + p.commit.length + Buffer.byteLength(p.note_json);
  }
  return { stored, bytes };
}

const teamIdOf = (team) => (typeof team === 'string' ? team : team?.id);

// { [sha]: note } for the given commits of one of the team's repos. Commits
// without a note (or not shas) are left out. At most 5000 shas per call, and
// at most `maxBytes` of stored note JSON is parsed (the rest is left out): a
// caller on a request or job path passes a budget, since every note can be
// 256 KB.
export function provenanceFor(db, team, repoId, shas, { maxBytes = Infinity } = {}) {
  const teamId = teamIdOf(team);
  const out = {};
  if (!teamId || typeof repoId !== 'string' || !SHA.test(repoId) || !Array.isArray(shas)) return out;
  const want = [...new Set(shas.filter((s) => typeof s === 'string' && SHA.test(s)))].slice(0, 5000);
  let left = maxBytes;
  for (let i = 0; i < want.length && left > 0; i += 500) {
    const part = want.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT commit_sha, LENGTH(note_json) AS n FROM h_provenance WHERE team_id = ? AND repo_id = ? AND commit_sha IN (${part.map(() => '?').join(',')})`)
      .all(teamId, repoId, ...part);
    const get = db.prepare('SELECT note_json FROM h_provenance WHERE team_id = ? AND repo_id = ? AND commit_sha = ?');
    for (const r of rows) {
      if ((left -= r.n) < 0) break;
      try {
        out[r.commit_sha] = parseNote(get.get(teamId, repoId, r.commit_sha).note_json);
      } catch {}
    }
  }
  return out;
}

// The team's hub repos synced from this GitHub repo ("owner/name", any
// case), newest sync first: [{ id, name, github }].
export function repoByGitHub(db, team, fullName) {
  const teamId = teamIdOf(team);
  if (!teamId || typeof fullName !== 'string' || !fullName.includes('/')) return [];
  return db
    .prepare('SELECT id, name, github FROM repos WHERE team_id = ? AND github = ? COLLATE NOCASE ORDER BY COALESCE(last_sync_at, created_at) DESC')
    .all(teamId, fullName.replace(/^github\.com\//i, ''));
}
