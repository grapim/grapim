// Pagination helper for list endpoints.
export function pageOf(items, page = 1, size = 20) {
  const start = page * size;
  return items.slice(start, start + size);
}

export function orderBy(db, column) {
  return db.query("SELECT id, name FROM users ORDER BY " + column);
}
