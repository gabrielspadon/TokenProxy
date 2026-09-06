import { getAdapter } from '../driver.js';

// Persistence for normalized quota evidence (Account Scheduling Contract rule
// 1). One row per (connection, window); the row shape is exactly what
// src/shared/utils/quotaRanking.js normalizes and ranks, so nothing between the
// provider read and the ranker reshapes the record.
//
// `limit` is a SQLite keyword, so every statement here quotes it. The column is
// declared as the quoted identifier in schema.js for the same reason.

// Written and read as absolute units. A row whose numbers did not survive the
// round trip (a NULL limit, a text remaining) is returned as-is rather than
// repaired: normalizeAccountWindows is the single authority on what a usable
// window is, and a repair here would hide bad evidence from it.
function rowToWindow(row) {
  return {
    scope: row.scope,
    remaining: row.remaining,
    limit: row.limit,
    resetAt: row.resetAt,
    observedAt: row.observedAt,
    confidence: row.confidence,
  };
}

// A window the caller did not fully specify still becomes a row, because the
// ranker's failure direction is per-account and soft: an account with a
// malformed window falls out of ranking and stays failover inventory. Dropping
// the row here instead would make the account look like it simply has fewer
// windows, which ranks it AGAINST accounts that reported honestly.
function windowToParams(connectionId, w) {
  return [
    connectionId,
    String(w?.scope ?? ''),
    w?.remaining ?? null,
    w?.limit ?? null,
    w?.resetAt ?? null,
    w?.observedAt ?? new Date().toISOString(),
    typeof w?.confidence === 'string' ? w.confidence : 'unknown',
  ];
}

// Replace-all for one connection, in one transaction. A quota read is a
// SNAPSHOT of every window the provider reports, so merging it with what was
// stored would resurrect a window the provider has since stopped reporting and
// leave the ranker comparing a shape no account actually has (the cohort gate
// then degrades the whole group to previous-pin stickiness). Delete-then-insert
// inside one transaction is also what makes a concurrent reader see either the
// whole old snapshot or the whole new one, never a half-written mix.
// Repeated selection of the same snapshot skips writes. A newer observation
// remains meaningful even when its numbers did not change.
function windowsUnchanged(existing, list) {
  if (existing.length !== list.length) return false;
  const byScope = new Map(list.map((w) => [String(w?.scope ?? ''), w]));
  if (byScope.size !== list.length) return false;
  for (const row of existing) {
    const w = byScope.get(row.scope);
    if (!w) return false;
    if (w.observedAt != null && w.observedAt !== row.observedAt) return false;
    if ((w.remaining ?? null) !== (row.remaining ?? null)) return false;
    if ((w.limit ?? null) !== (row.limit ?? null)) return false;
    if ((w.resetAt ?? null) !== (row.resetAt ?? null)) return false;
    const confidence = typeof w.confidence === 'string' ? w.confidence : 'unknown';
    if (confidence !== row.confidence) return false;
  }
  return true;
}

export async function putWindows(connectionId, windows) {
  if (!connectionId) return 0;
  const list = Array.isArray(windows) ? windows : [];
  const db = await getAdapter();
  const existing = db.all(
    `SELECT scope, remaining, "limit" AS "limit", resetAt, observedAt, confidence
     FROM quotaWindows WHERE connectionId = ?`,
    [connectionId]
  );
  if (windowsUnchanged(existing, list)) return list.length;
  db.transaction(() => {
    db.run(`DELETE FROM quotaWindows WHERE connectionId = ?`, [connectionId]);
    for (const w of list) {
      db.run(
        `INSERT INTO quotaWindows(connectionId, scope, remaining, "limit", resetAt, observedAt, confidence)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connectionId, scope) DO UPDATE SET
           remaining = excluded.remaining,
           "limit" = excluded."limit",
           resetAt = excluded.resetAt,
           observedAt = excluded.observedAt,
           confidence = excluded.confidence`,
        windowToParams(connectionId, w)
      );
    }
  });
  return list.length;
}

export async function getWindows(connectionId) {
  if (!connectionId) return [];
  const db = await getAdapter();
  const rows = db.all(
    `SELECT scope, remaining, "limit" AS "limit", resetAt, observedAt, confidence
     FROM quotaWindows WHERE connectionId = ?`,
    [connectionId]
  );
  return rows.map(rowToWindow);
}

// Every connection's windows in one scan, keyed by connection id. Ranking is a
// COHORT operation — it compares window shapes across every account for a
// provider node — so the caller needs all of them at once, and N per-connection
// reads would be N round trips to answer one question.
export async function getAllWindows() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT connectionId, scope, remaining, "limit" AS "limit", resetAt, observedAt, confidence
     FROM quotaWindows`
  );
  const map = new Map();
  for (const row of rows) {
    let list = map.get(row.connectionId);
    if (!list) {
      list = [];
      map.set(row.connectionId, list);
    }
    list.push(rowToWindow(row));
  }
  return map;
}
