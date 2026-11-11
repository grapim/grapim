// Where the App reads a team's provenance: the GitHub owner/name -> hub repo
// mapping, the notes of given commits, review decisions made in the hub (the
// only ones require_review counts), and the review statuses machines synced
// (shown, never counted). The provenance builder owns that data (docs/provenance.md
// section 3, src/hub/provenance.js): this adapter uses its helpers on
// hub.read (repoByGitHub, provenanceFor) and falls back to the tables the
// contract names (repos.github, h_provenance).
//
// Every query is scoped by team id, and repos are looked up inside the team.
// One GitHub repo can map to more than one hub repo (clones whose root commit
// differs); the App reads all of them, newest sync first.

const REVIEWS = ['pending', 'approved', 'rejected'];
const SHA = /^[0-9a-f]{40}$/i;

// "https://github.com/Owner/Name.git", "git@github.com:owner/name",
// "github.com/owner/name", "owner/name" -> "github.com/owner/name" (lowercase), else null.
export function normaliseRemote(url) {
  let s = String(url ?? '').trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) s = `github.com/${s}`;
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/]+@)?(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(s);
  return m ? `github.com/${m[1]}/${m[2]}`.toLowerCase() : null;
}

function notesMap(raw) {
  const out = new Map();
  const put = (sha, note) => {
    if (typeof sha === 'string' && SHA.test(sha) && note != null && !out.has(sha.toLowerCase())) out.set(sha.toLowerCase(), note);
  };
  if (raw instanceof Map) for (const [k, v] of raw) put(k, v);
  else if (Array.isArray(raw)) for (const r of raw) put(r?.commit ?? r?.commit_sha ?? r?.sha, r?.note ?? r?.note_json);
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) put(k, v);
  return out;
}

const idsOf = (repo) => [repo.id, ...(Array.isArray(repo.alt) ? repo.alt : [])].filter((x) => typeof x === 'string');

// store: the hub's HubReviews (src/hub/reviews.js), for hub decisions.
export function provenanceSource(hub, opts = {}, store = null) {
  const { db } = hub;
  const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  // A test override in opts, else the hub's helper of that name.
  const helper = (optName, hubName = optName) => {
    if (typeof opts[optName] === 'function') return opts[optName];
    for (const owner of [hub.read, hub]) if (typeof owner?.[hubName] === 'function') return owner[hubName].bind(owner);
    return null;
  };

  // { id, alt: [more ids] } for the hub repos a GitHub repo ("owner/name") maps to, or null.
  async function repoFor(team, fullName) {
    const want = normaliseRemote(fullName);
    if (!want) return null;
    let rows;
    const fn = helper('repoFor', 'repoByGitHub');
    if (fn) rows = await fn(team, fullName);
    else {
      const cols = db.prepare('PRAGMA table_info(repos)').all().map((c) => c.name);
      rows = cols.includes('github') ? db.prepare('SELECT id, github FROM repos WHERE team_id = ? AND github IS NOT NULL').all(team.id).filter((r) => normaliseRemote(r.github) === want) : [];
    }
    const list = (Array.isArray(rows) ? rows : rows ? [rows] : []).map((r) => (typeof r === 'string' ? { id: r } : r)).filter((r) => typeof r?.id === 'string').slice(0, 5);
    return list.length ? { ...list[0], alt: list.slice(1).map((r) => r.id) } : null;
  }

  // Map sha -> note (object or JSON) for the commits that have one.
  async function notesFor(team, repo, shas, { maxBytes = Infinity } = {}) {
    const list = [...new Set(shas)].filter((s) => SHA.test(s));
    const out = new Map();
    if (!list.length) return out;
    const fn = helper('provenanceFor');
    const ids = idsOf(repo);
    for (const repoId of ids) {
      let got;
      if (fn) got = notesMap(await fn(team, repoId, list, { maxBytes: maxBytes / ids.length }));
      else if (hasTable('h_provenance')) {
        got = new Map();
        for (let i = 0; i < list.length; i += 500) {
          const chunk = list.slice(i, i + 500);
          const rows = db
            .prepare(`SELECT commit_sha, note_json FROM h_provenance WHERE team_id = ? AND repo_id = ? AND commit_sha IN (${chunk.map(() => '?').join(',')})`)
            .all(team.id, repoId, ...chunk);
          for (const r of rows) got.set(String(r.commit_sha).toLowerCase(), r.note_json);
        }
      } else got = new Map();
      for (const [k, v] of got) if (!out.has(k)) out.set(k, v);
    }
    return out;
  }

  // Whether the team has any provenance for this repo (else the PR gets the
  // short "how to enable" comment).
  async function hasAny(team, repo) {
    if (typeof opts.hasProvenance === 'function') return !!(await opts.hasProvenance(team, repo));
    if (!hasTable('h_provenance')) return false;
    return idsOf(repo).some((id) => !!db.prepare('SELECT 1 FROM h_provenance WHERE team_id = ? AND repo_id = ? LIMIT 1').get(team.id, id));
  }

  // Map run id -> review status, from the review events the team synced
  // (`grapim review` records "approved", "rejected: <note>", ...). Newest wins.
  async function reviewsFor(team, repo, runIds) {
    const ids = [...new Set(runIds)].filter((r) => typeof r === 'string' && r);
    if (typeof opts.reviewsFor === 'function') {
      const r = await opts.reviewsFor(team, repo, ids);
      return r instanceof Map ? r : new Map(Object.entries(r ?? {}));
    }
    const out = new Map();
    const rows = [];
    for (const repoId of idsOf(repo)) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        rows.push(
          ...db
            .prepare(`SELECT agent, detail, ts, id FROM h_events WHERE team_id = ? AND repo_id = ? AND kind = 'review' AND agent IN (${chunk.map(() => '?').join(',')})`)
            .all(team.id, repoId, ...chunk),
        );
      }
    }
    rows.sort((a, b) => a.ts - b.ts || a.id - b.id);
    for (const r of rows) {
      const status = /^(pending|approved|rejected)\b/.exec(String(r.detail ?? ''))?.[1];
      if (REVIEWS.includes(status)) out.set(r.agent, status);
    }
    return out;
  }

  // The commits that have a stored note at all (an empty one included), so a
  // note the job could not parse is never mistaken for "not recorded". null
  // when a test replaces provenanceFor: the caller then uses notesFor's keys.
  async function notedFor(team, repo, shas) {
    if (typeof opts.notedFor === 'function') return new Set(await opts.notedFor(team, repo, shas));
    if (typeof opts.provenanceFor === 'function' || !hasTable('h_provenance')) return null;
    const list = [...new Set(shas)].filter((s) => SHA.test(s)).map((s) => s.toLowerCase());
    const out = new Set();
    for (const repoId of idsOf(repo)) {
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        for (const r of db.prepare(`SELECT commit_sha FROM h_provenance WHERE team_id = ? AND repo_id = ? AND commit_sha IN (${chunk.map(() => '?').join(',')})`).all(team.id, repoId, ...chunk)) out.add(r.commit_sha);
      }
    }
    return out;
  }

  // Hub reviews (src/hub/reviews.js): Map run id -> the newest decision made in the hub.
  async function hubReviewsFor(team, repo, runIds) {
    if (typeof opts.hubReviewsFor === 'function') {
      const r = await opts.hubReviewsFor(team, repo, runIds);
      return r instanceof Map ? r : new Map(Object.entries(r ?? {}));
    }
    return store ? store.latest(team, idsOf(repo), runIds) : new Map();
  }

  // Reviews synced from machines: Map run id -> { status, login, machine }. Informational only.
  async function localReviewsFor(team, repo, runIds) {
    if (typeof opts.reviewsFor === 'function') {
      const r = await reviewsFor(team, repo, runIds);
      return new Map([...r].map(([k, v]) => [k, typeof v === 'string' ? { status: v } : v]));
    }
    return store ? store.local(team, idsOf(repo), runIds) : new Map([...(await reviewsFor(team, repo, runIds))].map(([k, v]) => [k, { status: v }]));
  }

  // Map run id -> { repo_id, machine }: where its hub review page is.
  async function placesFor(team, repo, runIds) {
    if (typeof opts.placesFor === 'function') return new Map(Object.entries((await opts.placesFor(team, repo, runIds)) ?? {}));
    return store ? store.places(team, idsOf(repo), runIds) : new Map();
  }

  return { repoFor, notesFor, notedFor, hasAny, reviewsFor, hubReviewsFor, localReviewsFor, placesFor };
}
