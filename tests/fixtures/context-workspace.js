// Synthetic UI evidence only. Never import this fixture into a runtime or seed a historical snapshot.
export const SYNTHETIC_CONTEXT_LABEL = 'Synthetic context workshop fixture';
const stages = ['tools','schema','thinking','rtk','privacy','inject','pxpipe','mem','headroom','qac','pairs','reorder','midinject','final'];
function stageChain() {
  let before = 5000;
  return stages.map((stage, ordinal) => {
    const deltaBytes = ({ schema: -20, rtk: -1000, inject: 40, final: 20 })[stage] || 0;
    const row = { stage, ordinal, beforeBytes: before, afterBytes: before + deltaBytes, deltaBytes,
      outcome: deltaBytes ? 'applied' : 'skipped', risk: 'semantic_preserving' };
    before = row.afterBytes; return row;
  });
}
export function contextFixture() {
  const start = '2026-09-06T10:00:00.000Z';
  const last = '2026-09-06T10:02:00.000Z';
  const session = { id: 7, projectLabel: 'Synthetic research', identitySource: 'inferred', clientTool: 'synthetic-cli', firstSeenAt: start, lastSeenAt: last, attempts: 3, requests: 3, providerInputTokens: 1600, savedBytes: 2880 };
  const turns = [
    { id: 101, timestamp: start, status: 'success', usageSource: 'provider', providerInputTokens: 1200, providerOutputTokens: 80, cacheReadTokens: 400, cacheWriteTokens: 0, contextEstimate: 1250 },
    { id: 102, timestamp: '2026-09-06T10:01:00.000Z', status: 'pending', usageSource: 'estimated', providerInputTokens: null, providerOutputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, contextEstimate: 1500, estimatedInputTokens: 1450, estimatedOutputTokens: 5 },
    { id: 103, timestamp: last, status: 'error', usageSource: 'provider', providerInputTokens: 400, providerOutputTokens: null, cacheReadTokens: 50, cacheWriteTokens: null, contextEstimate: 420 },
  ].map((turn) => ({ ...turn, logicalRequestId: `synthetic-${turn.id}`, attempt: 1, provider: 'synthetic-provider', model: 'synthetic-model', requestedModel: 'synthetic-model', connectionId: 'synthetic-account', clientTool: 'synthetic-cli',
    bodyBeforeBytes: 5000, bodyAfterBytes: 4040, savedBytes: 960, messageCount: 8, toolCount: 2,
    compactHint: turn.id === 102, controls: { rtk: true, schema: true, rtkAllowLossy: false }, stages: stageChain(), routeKind: 'direct', formatPair: 'claude:claude' }));
  const summary = { attempts: 3, requests: 3, sessions: 1, succeeded: 1, pending: 1, failed: 1, providerUsageSamples: 2, estimatedUsageSamples: 1, missingUsageSamples: 0,
    providerInputTokens: 1600, providerOutputTokens: 80, cacheReadTokens: 450, cacheWriteTokens: 0,
    cacheEligibleInputTokens: 1600, cacheEligibleReadTokens: 450, cacheHitRate: 450 / 1600,
    estimatedInputTokens: 1450, estimatedOutputTokens: 5, savedBytes: 2880, firstSeenAt: start, lastSeenAt: last };
  const freshness = { source: 'committed-sqlite', snapshotStartedAt: '2026-09-06T10:03:00.000Z', snapshotCompletedAt: '2026-09-06T10:03:00.000Z', persistedAt: null };
  const pagination = { page: 1, pageSize: 25, totalItems: 3, totalPages: 1, hasPrev: false, hasNext: false };
  return {
    overview: { view: 'full', recording: { totalRetainedAttempts: 5, attributedAttempts: 3, rejectedAttempts: 1, unattributedAttempts: 1, scope: 'filtered retained attempts' }, summary,
      sessions: [session], projects: [{ projectLabel: session.projectLabel, sessions: 1, attempts: 3 }], pagination: { ...pagination, totalItems: 1, pageSize: 20 }, retentionDays: 45, recordingStartedAt: start, freshness },
    detail: { session, summary, turns, pagination, freshness,
      trend: { bucketMs: 60000, scope: 'All filtered attempts in this session; empty intervals are omitted.', points: turns.map((turn) => ({ bucketStart: turn.timestamp, firstSeenAt: turn.timestamp, lastSeenAt: turn.timestamp, attempts: 1, maxContextEstimate: turn.contextEstimate, providerInputTokens: turn.providerInputTokens, cacheReadTokens: turn.cacheReadTokens, savedBytes: turn.savedBytes })) },
      pins: [{ model: 'synthetic-model', connectionId: 'synthetic-account', pinnedAt: start, expiresAt: '2026-09-06T11:00:00.000Z' }],
      switches: [{ id: 1, fromConnectionId: 'synthetic-old', toConnectionId: 'synthetic-account', switchedAt: start, trigger: 'account_cooldown', reason: 'Synthetic cooldown receipt', model: 'synthetic-model' }],
      routingScope: 'Latest retained affinity and at most 100 switch receipts for this session, independent of the turn time filter.',
    },
  };
}
