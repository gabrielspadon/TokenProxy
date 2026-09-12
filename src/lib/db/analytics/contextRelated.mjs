import { CONTEXT_BOUNDARIES, normalizeContextStructure } from './contextStructure.mjs';
import { telemetryFilterSql } from './telemetryFilter.mjs';

export const CONTEXT_STRUCTURE_DEFINITIONS = {
  units: 'UTF-8 bytes of serialized JSON; not tokens or decoded media bytes.',
  partition: 'messageBytes + instructionBytes + toolSchemaBytes + envelopeBytes = bodyBytes. Role bytes plus messageContainerBytes = messageBytes.',
  subsets: 'Tool call, tool result and attachment bytes overlap role bytes and may overlap each other; never sum these as a partition.',
  historyPrefix: 'A structured history/instructions/tools fingerprint before the latest syntactic user message; not the provider wire prefix, cache eligibility, or proof of compaction.',
  missing: 'Absent boundaries are unavailable, disabled, unsupported binary transport, or historical missing evidence; never zero.',
  fingerprints: 'Installation-keyed HMAC-SHA256 fingerprints, comparable only within the same installation key.',
};
export const OWNED_EVENT_LINK = `e.clientKeyId=r.clientKeyId
  AND (e.logicalRequestId IS NULL OR e.logicalRequestId=r.logicalRequestId)
  AND (e.contextSessionId IS NULL OR e.contextSessionId=r.contextSessionId)`;
const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// These projections run within their caller's read transaction. IDs come only
// from the selected request rows; no content or timestamp-based joins are used.
export function readContextRelated(db, ids) {
  const structures = new Map(), costs = new Map(), handoffs = new Map();
  let rejectedStructures = 0;
  for (let offset = 0; offset < ids.length; offset += 100) {
    const page = ids.slice(offset, offset + 100), placeholders = page.map(() => '?').join(',');
    // Preserve independent handoff metadata and missing historical references;
    // mask identifiers and session evidence from retained excluded requests.
    for (const row of db.all(`SELECT a.requestId,a.handoffId,a.executionRequestId,a.logicalRequestId,a.appliedAt,
      CASE WHEN source.id IS NULL OR ${telemetryFilterSql('requestStats', 'source')} THEN h.sourceRequestId END AS sourceRequestId,
      CASE WHEN target.id IS NULL OR ${telemetryFilterSql('requestStats', 'target')} THEN h.targetRequestId END AS targetRequestId,
      h.projectId,h.contentHash,h.expiresAt,h.revokedAt,
      CASE WHEN ${telemetryFilterSql('requestStats', 'source')} THEN source.contextSessionId END AS sourceSessionId,
      CASE WHEN ${telemetryFilterSql('requestStats', 'target')} THEN target.contextSessionId END AS targetSessionId
      FROM contextHandoffApplications a JOIN shapingHandoffs h ON h.id=a.handoffId JOIN requestStats r ON r.id=a.requestId
      LEFT JOIN requestStats source ON source.id=h.sourceRequestId LEFT JOIN requestStats target ON target.id=h.targetRequestId
      WHERE a.requestId IN (${placeholders}) AND a.logicalRequestId=r.logicalRequestId
      AND ${telemetryFilterSql('requestStats', 'r')} ORDER BY a.appliedAt,a.handoffId`, page)) {
      if (!handoffs.has(row.requestId)) handoffs.set(row.requestId, []);
      handoffs.get(row.requestId).push(row);
    }
    for (const row of db.all(`SELECT s.requestId,s.boundary,s.data FROM contextStructures s JOIN requestStats r ON r.id=s.requestId
      WHERE r.id IN (${placeholders}) AND ${telemetryFilterSql('requestStats', 'r')}`, page)) {
      try {
        const value = normalizeContextStructure(JSON.parse(row.data));
        if (value.boundary !== row.boundary) throw new Error('Invalid boundary');
        if (!structures.has(row.requestId)) structures.set(row.requestId, []);
        structures.get(row.requestId).push(value);
      } catch { rejectedStructures++; }
    }
    for (const row of db.all(`SELECT u.id,u.requestId,u.timestamp,u.cost,u.costSource,u.estimatedCostUsd,u.reportedCostUsd,u.rateSnapshotId,u.pricingCapturedAt
      FROM usageHistory u JOIN requestStats r ON r.id=u.requestId
      WHERE r.id IN (${placeholders}) AND (u.logicalRequestId IS NULL OR u.logicalRequestId=r.logicalRequestId)
      AND (u.contextSessionId IS NULL OR u.contextSessionId=r.contextSessionId)
      AND ${telemetryFilterSql('requestStats', 'r')} AND ${telemetryFilterSql('usageHistory', 'u')} ORDER BY u.id`, page)) {
      if (!costs.has(row.requestId)) costs.set(row.requestId, []);
      costs.get(row.requestId).push({ ledgerId: row.id, requestId: row.requestId, timestamp: row.timestamp,
        recordedCostUsd: amount(row.cost), estimatedCostUsd: amount(row.estimatedCostUsd), reportedCostUsd: amount(row.reportedCostUsd),
        costSource: ['provider-reported','application-estimate','unknown'].includes(row.costSource) ? row.costSource : null, rateSnapshotId: row.rateSnapshotId ?? null, pricingCapturedAt: row.pricingCapturedAt ?? null });
    }
  }
  for (const values of structures.values()) values.sort((a,b) => CONTEXT_BOUNDARIES.indexOf(a.boundary)-CONTEXT_BOUNDARIES.indexOf(b.boundary));
  return { structures, costs, handoffs, rejectedStructures };
}
