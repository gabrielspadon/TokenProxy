import { telemetryFilterSql } from './telemetryFilter.mjs';

const MAX_KEYS = 5000;

export function validateKeyUsageQuery(query) {
  if (query?.operation !== 'key-usage' || Object.keys(query).length !== 1) throw new Error('Invalid key usage projection');
  return query;
}

// Only stable public IDs cross the worker boundary. Historical credentials stay
// inside SQLite, and this projection does not infer identity across rotation.
export function readKeyUsage(db) {
  if (db.get('SELECT COUNT(*) AS count FROM apiKeys').count > MAX_KEYS) throw new Error('Key usage population exceeds limit');
  const rows = db.all(`SELECT a.id,COUNT(u.id) AS requests,
    SUM(u.promptTokens) AS promptTokens,SUM(u.completionTokens) AS completionTokens,SUM(u.cost) AS costUsd,
    COUNT(u.id)-COUNT(u.promptTokens) AS unknownPromptRows,
    COUNT(u.id)-COUNT(u.completionTokens) AS unknownCompletionRows,
    COUNT(u.id)-COUNT(u.cost) AS unknownCostRows,
    SUM(CASE WHEN u.cost=0 AND u.costSource IS NULL THEN 1 ELSE 0 END) AS ambiguousZeroCostRows,
    MIN(u.timestamp) AS firstRecordedAt,MAX(u.timestamp) AS lastRecordedAt
    FROM apiKeys a LEFT JOIN usageHistory u ON u.apiKey=a.key AND ${telemetryFilterSql('usageHistory', 'u')} GROUP BY a.id`);
  return { scope: 'retained-history-for-current-credential', totals: Object.fromEntries(rows.map(({id,...row}) => [id, {
    ...row, promptTokens: row.requests ? row.promptTokens : 0,
    completionTokens: row.requests ? row.completionTokens : 0, costUsd: row.requests ? row.costUsd : 0,
  }])) };
}
