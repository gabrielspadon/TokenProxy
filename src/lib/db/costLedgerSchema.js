// Counterfactual dollar-cost ledger. One row per completed request, keyed by
// the request rid (fallback retries share one rid across attempts, so a row is
// upserted and the last completed attempt wins).
//
// Numbers and ids only — never prompt text, message bodies, or identity
// material. The counterfactual invariant: `baselineUsd` costs the ACTUAL
// pre-saver serialized request body as if fully uncached, and `actualUsd`
// costs the PROVIDER-REPORTED usage with cache multipliers. Savings are never
// estimated without the baseline. Token estimates use the repository-wide
// estimator: serialized body string length / 4, rounded up (the same ~4
// chars/token convention the token-saver byte ledger documents).
//
// Per-saver attribution is a query-time join: saver events (tokenSaver
// events.jsonl rows) and ledger rows share the rid, so no saver-identity
// column exists here and the SAVERS allowlist needs no entry for this table.
// saverSavedUsd/cacheSavedUsd are the dollar split of savedUsd: the saver
// component (baseline minus the actual usage priced fully uncached) and the
// provider cache-discount component (that uncached actual minus the
// cache-priced actual). saverSavedUsd + cacheSavedUsd = savedUsd by
// construction. Rows written before the split carry 0/0 — the decomposition
// of their savedUsd is unknown, not zero; only their total stays honest.
export const COST_LEDGER_TABLES = {
  costLedger: {
    columns: {
      id: 'TEXT PRIMARY KEY', // request rid
      completionId: 'TEXT', // server-generated UUID shared with one usage completion; legacy NULL
      ts: 'TEXT NOT NULL', // ISO-8601 completion timestamp
      sid: 'TEXT', // client session id; NULL when the request carried none
      provider: 'TEXT',
      model: 'TEXT',
      baselineUsd: 'REAL NOT NULL',
      actualUsd: 'REAL NOT NULL',
      savedUsd: 'REAL NOT NULL', // baseline - actual; negative = savers grew the body
      saverSavedUsd: 'REAL NOT NULL DEFAULT 0', // saver component of savedUsd
      cacheSavedUsd: 'REAL NOT NULL DEFAULT 0', // cache-discount component
      inputTokens: 'INTEGER NOT NULL DEFAULT 0', // cache-inclusive provider input
      cacheReadTokens: 'INTEGER NOT NULL DEFAULT 0',
      cacheWriteTokens: 'INTEGER NOT NULL DEFAULT 0',
      outputTokens: 'INTEGER NOT NULL DEFAULT 0',
    },
    indexes: [
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_cl_completion ON costLedger(completionId) WHERE completionId IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_cl_sid_ts ON costLedger(sid, ts)',
      'CREATE INDEX IF NOT EXISTS idx_cl_ts ON costLedger(ts)',
    ],
  },
};
