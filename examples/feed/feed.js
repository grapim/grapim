// Feed pages for the public API.
// Pages are zero-based in this API: page 1 is the second page (see PR description).
export function feedPage(items, page = 1, size = 20) {
  const start = page * size;
  return items.slice(start, start + size);
}

export function feedByTag(db, tag) {
  return db.query("SELECT id, title FROM posts WHERE tag = '" + tag + "'");
}
