// "Fixes #12", "closes owner/repo#3", issue URLs: the request behind a PR.
export function linkedIssues(text, repo) {
  const out = new Set();
  const s = String(text ?? '');
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|addresses|implements)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;
  for (const m of s.matchAll(re)) if (!m[1] || m[1].toLowerCase() === repo.toLowerCase()) out.add(Number(m[2]));
  const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const url = new RegExp(`github\\.com/${esc}/issues/(\\d+)`, 'gi');
  for (const m of s.matchAll(url)) out.add(Number(m[1]));
  return [...out].slice(0, 5);
}
