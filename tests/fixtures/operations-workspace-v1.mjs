// Disposable preview seed. This module never opens a database or contacts a provider.
export const OPERATIONS_FIXTURE = Object.freeze({
  version: 'operations-workspace-v1',
  capturedAt: '2026-09-07T12:00:00.000Z',
  source: 'synthetic-operator-scenario',
  ruleId: 'a0000000-0000-4000-8000-000000000001',
  alertId: 'a0000000-0000-4000-8000-000000000002',
});

export function seedOperationsWorkspace(db, { accountId = 'fixture-account-1' } = {}) {
  const { capturedAt, ruleId, alertId } = OPERATIONS_FIXTURE;
  const rule = {
    id: ruleId,
    name: 'Synthetic quota review',
    conditionKind: 'quota_risk',
    scopeKind: 'connection',
    scopeId: accountId,
    threshold: 10,
    durationSeconds: 900,
    cooldownSeconds: 3600,
    enabled: false,
    revision: 1,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
  db.run(
    'INSERT OR IGNORE INTO notificationRules(id,name,conditionKind,scopeKind,scopeId,threshold,durationSeconds,cooldownSeconds,enabled,revision,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      rule.id,
      rule.name,
      rule.conditionKind,
      rule.scopeKind,
      rule.scopeId,
      rule.threshold,
      rule.durationSeconds,
      rule.cooldownSeconds,
      0,
      1,
      capturedAt,
      capturedAt,
    ]
  );
  db.run(
    'INSERT OR IGNORE INTO notificationRuleVersions(ruleId,revision,change,definition,changedAt) VALUES (?,?,?,?,?)',
    [ruleId, 1, 'created', JSON.stringify(rule), capturedAt]
  );
  db.run(
    'INSERT OR IGNORE INTO notificationRuleEvents(id,ruleId,ruleRevision,scopeKey,firedAt,breachStartedAt,observedValue,evidence,outcome) VALUES (?,?,?,?,?,?,?,?,?)',
    [
      alertId,
      ruleId,
      1,
      `${accountId}::synthetic-window`,
      capturedAt,
      '2026-09-07T11:45:00.000Z',
      7,
      JSON.stringify({
        kind: 'quotaObservation',
        refs: [],
        fixtureVersion: OPERATIONS_FIXTURE.version,
      }),
      'firing',
    ]
  );
  return { ...OPERATIONS_FIXTURE, accountId };
}
