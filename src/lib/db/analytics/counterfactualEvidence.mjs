import { isCompletionId } from '../completionIdentity.mjs';
import { telemetryFilterSql } from './telemetryFilter.mjs';

const signed = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => signed(value) && value >= 0;
const token = value => Number.isSafeInteger(value) && value >= 0;
const reconciles = (a, b) => signed(a) && signed(b)
  && Math.abs(a - b) <= Math.max(1e-12, Math.abs(a) * 1e-10, Math.abs(b) * 1e-10);

// The counterfactual ledger can replace a fallback's earlier completion. An
// server-generated completion UUID and unique mapping are required. A rid is
// client-controllable and may collide, so legacy rows stay unbound.
export function counterfactualEvidence(row, entry, matches = 0) {
  const unavailable = state => ({ state, available: false, source: 'costLedger', unit: 'USD' });
  if (!isCompletionId(row.completionId)) return unavailable('identity-unavailable');
  if (!entry) return unavailable('not-retained');
  if (matches !== 1) return unavailable('ambiguous-completion');
  if (entry.completionId !== row.completionId || row.requestLink === 'conflict' || !row.provider || !row.model || entry.provider !== row.provider || entry.model !== row.model)
    return unavailable('identity-conflict');
  if (row.usageSource !== 'provider' || row.invalidTokens || row.inconsistentCache
    || ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].some(key => !token(row[key]) || row[key] !== entry[key])
    || row.cacheReadTokens + row.cacheWriteTokens > row.inputTokens)
    return unavailable('usage-conflict');
  if (![entry.baselineUsd, entry.actualUsd].every(nonnegative) || !signed(entry.savedUsd) || !reconciles(entry.baselineUsd - entry.actualUsd, entry.savedUsd))
    return unavailable('arithmetic-conflict');
  const splitAvailable = signed(entry.saverSavedUsd) && signed(entry.cacheSavedUsd)
    && !(entry.saverSavedUsd === 0 && entry.cacheSavedUsd === 0)
    && reconciles(entry.saverSavedUsd + entry.cacheSavedUsd, entry.savedUsd);
  return {
    available: true, state: 'linked', source: 'costLedger', unit: 'USD', id: entry.completionId,
    recordedAt: entry.ts, identityBasis: 'server-completion-id',
    baselineUsd: entry.baselineUsd, usageModelUsd: entry.actualUsd, modeledDifferenceUsd: entry.savedUsd,
    splitAvailable, inputEstimateDifferenceUsd: splitAvailable ? entry.saverSavedUsd : null,
    cachePricingDifferenceUsd: splitAvailable ? entry.cacheSavedUsd : null,
    rateSnapshotAvailable: false,
    baselineMethod: 'Pre-processing serialized request UTF-16 code units divided by 4, rounded up, priced as uncached input with the same reported output.',
    limitation: 'Modeled difference, not a provider charge or verified saving. The counterfactual calculator and rates differ from the completion ledger; its rate snapshot and baseline token estimate were not retained. A zero/zero split is historically ambiguous.',
  };
}

export function attachCounterfactualEvidence(db, rows) {
  for (const row of rows) row.completionId = isCompletionId(row.completionId) ? row.completionId : null;
  const ids = [...new Set(rows.map(row => row.completionId).filter(Boolean))];
  if (!ids.length) {
    for (const row of rows) row.counterfactual = counterfactualEvidence(row, null);
    return;
  }
  const columns = new Set(db.all('PRAGMA table_info(costLedger)', []).map(column => column.name));
  const byId = new Map(), counts = new Map();
  if (columns.has('completionId')) {
    // Bounded indexed lookups, including exports. Count defensively even with
    // unique indexes because imported databases may have failed index creation.
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400), marks = batch.map(() => '?').join(',');
      for (const entry of db.all(`SELECT *,COUNT(*) OVER (PARTITION BY completionId) AS bindings
        FROM costLedger WHERE completionId IN (${marks})`, batch)) byId.set(entry.completionId, entry);
      // Visibility cannot repair ambiguous raw identity bindings. Keep the full
      // retained count even when only one of several mappings is displayed.
      for (const mapping of db.all(`SELECT completionId,COUNT(*) AS matches,
        MAX(CASE WHEN ${telemetryFilterSql('usageHistory')} THEN 1 ELSE 0 END) AS visible
        FROM usageHistory WHERE completionId IN (${marks}) GROUP BY completionId`, batch)) counts.set(mapping.completionId, mapping);
    }
  }
  for (const row of rows) {
    const mapping = counts.get(row.completionId);
    const entry = mapping?.visible ? byId.get(row.completionId) : null;
    const matches = entry?.bindings === 1 ? mapping?.matches : 0;
    row.counterfactual = counterfactualEvidence(row, entry, matches);
  }
}
