// Read-only tools for the second look (verify.js): search and read the
// repository at the reviewed head, so a finding can be checked against code
// outside the diff (a caller that already guards the case, a convention the
// project documents, a helper in another file). Every tool runs a git command
// on the head commit through the `git(args)` function the caller gives; none
// runs code from the repository or writes anything.

const MAX_OUT = 12_000;
const MAX_HITS = 60;
const MAX_READ = 400;
const MAX_LIST = 300;

export const REPO_TOOLS = Object.freeze([
  {
    name: 'search',
    description: 'Search every file of the repository at the pull request head with an extended regular expression (git grep -E). Returns up to 60 matching lines as path:line:text. Use it to find callers, definitions, other places that handle the same case, and docs.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Extended regular expression, e.g. getGraphs|get-graphs' },
        path: { type: 'string', description: 'Optional pathspec to limit the search, e.g. src/ or *.rs' },
        ignore_case: { type: 'boolean' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a file at the pull request head with line numbers, up to 400 lines per call.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'list_files',
    description: 'List the files under a directory at the pull request head (recursive, up to 300 paths).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', description: 'Directory, e.g. src/main; empty for the root' } },
    },
  },
  {
    name: 'history',
    description: 'Recent commits that touched a path, up to the pull request head (subject lines). Shows whether something changed outside this pull request.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
  },
]);

const clip = (s) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (cut)` : s);
const cleanPath = (p) => String(p ?? '').replace(/^\.?\/+/, '').replace(/\\/g, '/');
// A quick check with JavaScript's parser, close enough to ERE for unbalanced
// brackets and dangling quantifiers.
const badEre = (p) => {
  try {
    new RegExp(p);
    return false;
  } catch {
    return true;
  }
};
const badPath = (p) => p.split('/').includes('..') || p.startsWith('-');

// -> text for the model. Never throws.
export function runRepoTool(git, head, name, input = {}) {
  try {
    if (name === 'search') {
      const pattern = String(input.pattern ?? '');
      if (!pattern || pattern.length > 300) return 'Give a pattern of 1 to 300 characters.';
      const path = cleanPath(input.path);
      if (path && badPath(path)) return 'That path is not allowed.';
      const args = ['grep', '-n', '-I', '-E', '--max-count=8', ...(input.ignore_case ? ['-i'] : []), '-e', pattern, head, '--', ...(path ? [path] : [])];
      const out = git(args);
      // git grep exits 1 for no match and 128 for a bad pattern; the caller's
      // git() returns null for both, so say both and how to escape.
      if (out == null || !out.trim()) return badEre(pattern) ? 'That pattern is not a valid extended regular expression: escape ( ) [ ] { } . * + ? | with a backslash, then search again.' : 'No matches (if the pattern has ( ) [ ] { } . * + ? |, escape them with a backslash).';
      const lines = out.split('\n').filter(Boolean).map((l) => (l.startsWith(`${head}:`) ? l.slice(head.length + 1) : l));
      const more = lines.length > MAX_HITS ? `\n… ${lines.length - MAX_HITS} more matches; narrow the pattern or the path.` : '';
      return clip(lines.slice(0, MAX_HITS).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join('\n') + more);
    }
    if (name === 'read_file') {
      const path = cleanPath(input.path);
      if (!path || badPath(path)) return 'Give a file path inside the repository.';
      const text = git(['show', `${head}:${path}`]);
      if (text == null) return `No file ${path} at the head.`;
      const lines = String(text).split('\n');
      const start = Math.max(1, Number(input.start) || 1);
      const end = Math.min(lines.length, Number(input.end) || start + MAX_READ - 1, start + MAX_READ - 1);
      const out = [];
      for (let i = start; i <= end; i++) out.push(`${String(i).padStart(5)}  ${lines[i - 1]}`);
      const tail = end < lines.length ? `\n… file has ${lines.length} lines; read on with start=${end + 1}.` : '';
      return clip(out.join('\n') + tail);
    }
    if (name === 'list_files') {
      const path = cleanPath(input.path);
      if (path && badPath(path)) return 'That path is not allowed.';
      const out = git(['ls-tree', '-r', '--name-only', head, ...(path ? ['--', path] : [])]);
      if (out == null || !out.trim()) return 'No files there.';
      const files = out.split('\n').filter(Boolean);
      return clip(files.slice(0, MAX_LIST).join('\n') + (files.length > MAX_LIST ? `\n… ${files.length - MAX_LIST} more; list a subdirectory.` : ''));
    }
    if (name === 'history') {
      const path = cleanPath(input.path);
      if (!path || badPath(path)) return 'Give a path inside the repository.';
      const out = git(['log', '--format=%h %ad %s', '--date=short', '-n', '15', head, '--', path]);
      return out && out.trim() ? clip(out.trim()) : 'No commits found for that path in the fetched history.';
    }
    return `No tool named ${name}.`;
  } catch (err) {
    return `The tool failed: ${String(err?.message ?? err).slice(0, 200)}`;
  }
}
