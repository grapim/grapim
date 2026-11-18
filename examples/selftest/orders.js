// Self-test for the review comment format (do not merge).
export function pageOf(items, page, size = 20) {
  const start = page * size; // page is 1-based
  return items.slice(start, start + size);
}

export function ordersQuery(db, customerId, orderBy) {
  return db.query(`SELECT * FROM orders WHERE customer_id = ${customerId} ORDER BY ${orderBy}`);
}
