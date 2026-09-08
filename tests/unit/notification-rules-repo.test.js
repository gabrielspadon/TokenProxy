// Rule persistence: optimistic concurrency, the alert state machine, and the
// dry run over retained historical rows. Real database per test, no mocks
// standing in for the constraint being tested.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir;
let repo;
let db;
const originalDataDir = process.env.DATA_DIR;

const RULE = {
  name: 'Session quota low',
  conditionKind: 'quota_risk',
  scopeKind: 'connection',
  scopeId: 'conn-1',
  threshold: 10,
  durationSeconds: 600,
  cooldownSeconds: 3600,
};

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-notifrepo-'));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete globalThis._contextAnalytics;
  vi.resetModules();
  const { getAdapter } = await import('@/lib/db/driver.js');
  db = await getAdapter();
  repo = await import('@/lib/db/repos/notificationRulesRepo.js');
});

afterEach(async () => {
  try {
    await globalThis._contextAnalytics?.client?.close();
  } catch {}
  delete globalThis._contextAnalytics;
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe('rule validation', () => {
  it('refuses a condition with no truthful data source behind it', async () => {
    await expect(
      repo.createRule({ ...RULE, conditionKind: 'unrecorded_condition' })
    ).rejects.toThrow(/Unsupported condition/);
  });

  it('refuses a threshold outside the condition’s declared range', async () => {
    await expect(repo.createRule({ ...RULE, threshold: 140 })).rejects.toThrow(/Threshold/);
  });

  it('refuses a cooldown below the floor, so a breach cannot alert per sample', async () => {
    await expect(repo.createRule({ ...RULE, cooldownSeconds: 10 })).rejects.toThrow(/Cooldown/);
  });

  it('refuses a scoped rule with no subject and a global rule with one', async () => {
    await expect(repo.createRule({ ...RULE, scopeId: '' })).rejects.toThrow(/subject/);
    const global = await repo.createRule({ ...RULE, scopeKind: 'global', scopeId: 'conn-1' });
    // scopeId is dropped rather than stored against a global rule.
    expect(global.scopeId).toBeNull();
  });
});

describe('optimistic concurrency', () => {
  it('increments the revision and records a version on every accepted write', async () => {
    const created = await repo.createRule(RULE);
    expect(created.revision).toBe(1);
    const updated = await repo.updateRule(created.id, 1, { ...RULE, threshold: 5 });
    expect(updated.revision).toBe(2);
    expect(updated.threshold).toBe(5);

    const versions = await repo.getRuleVersions(created.id);
    expect(versions.map((version) => version.revision)).toEqual([2, 1]);
    expect(versions.map((version) => version.change)).toEqual(['updated', 'created']);
    // The version log carries the definition as of that revision.
    expect(versions[1].definition.threshold).toBe(10);
    expect(versions[0].definition.threshold).toBe(5);
  });

  it('surfaces a conflict instead of silently overwriting a concurrent edit', async () => {
    const created = await repo.createRule(RULE);
    await repo.updateRule(created.id, 1, { ...RULE, threshold: 5 });

    // A second operator still holding revision 1 tries to save.
    let error;
    try {
      await repo.updateRule(created.id, 1, { ...RULE, threshold: 25 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(repo.RuleConflictError);
    expect(error.expected).toBe(1);
    // The conflict carries the live rule so the surface can show what changed.
    expect(error.actual.revision).toBe(2);
    expect(error.actual.threshold).toBe(5);

    // The losing write did not land.
    expect((await repo.getRule(created.id)).threshold).toBe(5);
  });

  it('refuses a delete carrying a stale revision', async () => {
    const created = await repo.createRule(RULE);
    await repo.updateRule(created.id, 1, { ...RULE, threshold: 5 });
    await expect(repo.deleteRule(created.id, 1)).rejects.toBeInstanceOf(repo.RuleConflictError);
    expect(await repo.getRule(created.id)).toBeTruthy();
  });

  it('records enabling and disabling as their own change kind', async () => {
    const created = await repo.createRule(RULE);
    await repo.updateRule(created.id, 1, { ...RULE, enabled: false });
    const versions = await repo.getRuleVersions(created.id);
    expect(versions[0].change).toBe('disabled');
  });
});

describe('alert state machine', () => {
  const firing = {
    firedAt: '2026-01-01T00:10:00.000Z',
    breachStartedAt: '2026-01-01T00:00:00.000Z',
    observedValue: 5,
    refs: ['obs-1', 'obs-2'],
  };

  it('records one open alert per rule and scope, never a duplicate', async () => {
    const rule = await repo.createRule(RULE);
    const first = await repo.recordFiring(rule, firing, 'conn-1::session');
    expect(first).toBeTruthy();
    expect(first.outcome).toBe('firing');
    // Evidence references the records, and does not copy their contents.
    expect(first.evidence).toEqual({ kind: 'quotaObservation', refs: ['obs-1', 'obs-2'] });

    const duplicate = await repo.recordFiring(rule, firing, 'conn-1::session');
    expect(duplicate).toBeNull();
    expect(await repo.listRuleEvents({ ruleId: rule.id })).toHaveLength(1);
  });

  it('a different scope key on the same rule is its own alert', async () => {
    const rule = await repo.createRule({ ...RULE, scopeKind: 'global', scopeId: null });
    expect(await repo.recordFiring(rule, firing, 'conn-1::session')).toBeTruthy();
    expect(await repo.recordFiring(rule, firing, 'conn-2::session')).toBeTruthy();
    expect(await repo.listRuleEvents({ ruleId: rule.id })).toHaveLength(2);
  });

  it('acknowledging is terminal, and frees the slot for a later firing', async () => {
    const rule = await repo.createRule(RULE);
    const alert = await repo.recordFiring(rule, firing, 'conn-1::session');
    const acknowledged = await repo.acknowledgeEvent(alert.id, {
      at: '2026-01-01T01:00:00.000Z',
    });
    expect(acknowledged.outcome).toBe('acknowledged');
    expect(acknowledged.acknowledgedAt).toBe('2026-01-01T01:00:00.000Z');

    // Re-acknowledging is refused rather than re-stamped, so the timestamp
    // keeps meaning "when the operator first took this".
    await expect(repo.acknowledgeEvent(alert.id)).rejects.toThrow(/already acknowledged/);

    // The slot is now free, so a genuinely new breach can alert again.
    expect(await repo.recordFiring(rule, firing, 'conn-1::session')).toBeTruthy();
  });

  it('snoozing suppresses repetition without resolving the alert', async () => {
    const rule = await repo.createRule(RULE);
    const alert = await repo.recordFiring(rule, firing, 'conn-1::session');
    const snoozed = await repo.snoozeEvent(alert.id, '2030-01-01T00:00:00.000Z');
    // Still firing: a snoozed problem is an open problem.
    expect(snoozed.outcome).toBe('firing');
    expect(snoozed.snoozedUntil).toBe('2030-01-01T00:00:00.000Z');
    expect(await repo.listRuleEvents({ outcome: 'firing' })).toHaveLength(1);
  });

  it('refuses a snooze that does not end in the future, or on a closed alert', async () => {
    const rule = await repo.createRule(RULE);
    const alert = await repo.recordFiring(rule, firing, 'conn-1::session');
    await expect(repo.snoozeEvent(alert.id, '2020-01-01T00:00:00.000Z')).rejects.toThrow(/future/);
    await expect(repo.snoozeEvent(alert.id, 'not-a-date')).rejects.toThrow(/valid instant/);
    await repo.acknowledgeEvent(alert.id);
    await expect(repo.snoozeEvent(alert.id, '2030-01-01T00:00:00.000Z')).rejects.toThrow(
      /acknowledged/
    );
  });

  it('keeps an alert pointed at the revision that produced it after the rule moves on', async () => {
    const rule = await repo.createRule(RULE);
    const alert = await repo.recordFiring(rule, firing, 'conn-1::session');
    await repo.updateRule(rule.id, 1, { ...RULE, threshold: 2 });
    const [stored] = await repo.listRuleEvents({ ruleId: rule.id });
    expect(stored.ruleRevision).toBe(1);
    expect(stored.ruleDefinition.threshold).toBe(10);
    expect(stored.ruleDefinition.conditionKind).toBe('quota_risk');
    expect((await repo.getRule(rule.id)).revision).toBe(2);
  });

  it('alerts survive deletion of the rule that produced them', async () => {
    const rule = await repo.createRule(RULE);
    await repo.recordFiring(rule, firing, 'conn-1::session');
    await repo.deleteRule(rule.id, 1);
    expect(await repo.getRule(rule.id)).toBeUndefined();
    expect(await repo.listRuleEvents({ ruleId: rule.id })).toHaveLength(1);
    expect((await repo.listRuleEvents({ ruleId: rule.id }))[0].ruleDefinition.name).toBe(RULE.name);
    // The version log records the deletion too.
    const versions = await repo.getRuleVersions(rule.id);
    expect(versions[0].change).toBe('deleted');
  });
});

describe('dry run over the retained historical population', () => {
  const observation = (id, minutes, remaining) =>
    db.run(
      `INSERT INTO quotaObservations(id, connectionId, provider, scope, source, observationKind,
         unit, remaining, "limit", percentage, observedAt, capturedAt, confidence)
       VALUES(?, 'conn-1', 'anthropic', 'session (5h)', 'headers', 'observed',
         'requests', ?, 100, NULL, ?, ?, 'fresh')`,
      [
        id,
        remaining,
        new Date(Date.parse('2026-01-01T00:00:00.000Z') + minutes * 60_000).toISOString(),
        new Date(Date.parse('2026-01-01T00:00:00.000Z') + minutes * 60_000).toISOString(),
      ]
    );

  it('reports what a rule would have fired on, linked to the causing records', async () => {
    // Headroom sits at 5% for well over the 10 minute duration.
    for (let index = 0; index <= 8; index += 1) observation(`obs-${index}`, index * 2, 5);

    const result = await repo.dryRunRule(RULE, {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
    });
    expect(result.complete).toBe(true);
    expect(result.evidenceAbsent).toBe(false);
    expect(result.firingCount).toBe(1);
    const [group] = result.groups;
    expect(group.scopeKey).toBe('conn-1::session (5h)');
    expect(group.firings[0].firedAt).toBe('2026-01-01T00:10:00.000Z');
    // Every firing links to the retained observation ids behind it.
    expect(group.firings[0].refs).toContain('obs-0');
    expect(group.firings[0].refs).toContain('obs-5');
  });

  it('writes nothing: a dry run is a read', async () => {
    for (let index = 0; index <= 8; index += 1) observation(`obs-${index}`, index * 2, 5);
    await repo.dryRunRule(RULE, {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
    });
    expect(db.get(`SELECT COUNT(*) AS c FROM notificationRuleEvents`).c).toBe(0);
    expect(db.get(`SELECT COUNT(*) AS c FROM notificationRules`).c).toBe(0);
  });

  it('does not fire on history that never sustained the breach', async () => {
    // Healthy throughout.
    for (let index = 0; index <= 8; index += 1) observation(`obs-${index}`, index * 2, 80);
    const result = await repo.dryRunRule(RULE, {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
    });
    expect(result.firingCount).toBe(0);
    expect(result.groups[0].state).toBe('not_fired');
  });

  it('reports absent evidence as absent, never as a pass', async () => {
    const result = await repo.dryRunRule(RULE, {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
    });
    expect(result.evidenceAbsent).toBe(true);
    expect(result.total).toBe(0);
    expect(result.groups).toEqual([]);
  });

  it('ignores an observation whose headroom cannot be measured', async () => {
    db.run(
      `INSERT INTO quotaObservations(id, connectionId, provider, scope, source, observationKind,
         unit, remaining, "limit", percentage, observedAt, capturedAt, confidence)
       VALUES('unmeasured', 'conn-1', 'anthropic', 'session (5h)', 'headers', 'observed',
         NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'unknown')`
    );
    const result = await repo.dryRunRule(RULE, {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
    });
    expect(result.firingCount).toBe(0);
    expect(result.groups[0].sampleCount).toBe(1);
    // Counted as retained but not as measured, so the gap is visible.
    expect(result.groups[0].measuredCount).toBe(0);
  });

  it('counts fallbacks from accountSwitches, excluding a session’s first pin', async () => {
    const switchRow = (id, minutes, trigger, from = 'conn-1') =>
      db.run(
        `INSERT INTO accountSwitches(id, sessionHash, model, fromConnectionId, toConnectionId,
           trigger, reason, windows, switchedAt)
         VALUES(?, 'hash', 'claude', ?, 'conn-2', ?, NULL, NULL, ?)`,
        [
          id,
          from,
          trigger,
          new Date(Date.parse('2026-01-01T00:00:00.000Z') + minutes * 60_000).toISOString(),
        ]
      );
    switchRow('s1', 0, 'exhaustion');
    switchRow('s2', 5, 'exhaustion');
    switchRow('s3', 8, 'initial-pin'); // not a fallback
    switchRow('s4', 10, 'model-failure');

    const result = await repo.dryRunRule(
      {
        ...RULE,
        name: 'Repeated fallback',
        conditionKind: 'repeated_fallback',
        threshold: 3,
        durationSeconds: 1800,
      },
      { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' }
    );
    // Three genuine fallbacks reach the threshold; the initial pin is excluded.
    expect(result.firingCount).toBe(1);
    expect(result.groups[0].firings[0].observedValue).toBe(3);
    expect(result.groups[0].firings[0].refs).toEqual(['s1', 's2', 's4']);
  });

  it('counts only failed operations, not cancelled or unresolved ones', async () => {
    const event = (operationId, minutes, state) =>
      db.run(
        `INSERT INTO operationEvents(operationId, phase, state, source, actorClass, subjectKind,
           subjectId, provider, connectionId, occurredAt, capturedAt, details)
         VALUES(?, 'reachability', ?, 'probe', 'background', 'connection', 'conn-1',
           'anthropic', 'conn-1', ?, ?, '{}')`,
        [
          operationId,
          state,
          new Date(Date.parse('2026-01-01T00:00:00.000Z') + minutes * 60_000).toISOString(),
          new Date(Date.parse('2026-01-01T00:00:00.000Z') + minutes * 60_000).toISOString(),
        ]
      );
    event('op-1', 0, 'failed');
    event('op-2', 2, 'cancelled');
    event('op-3', 4, 'uncertain');
    event('op-4', 6, 'failed');

    const rule = {
      ...RULE,
      name: 'Operation failures',
      conditionKind: 'operation_failure',
      threshold: 2,
      durationSeconds: 1800,
    };
    const result = await repo.dryRunRule(rule, {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
    });
    expect(result.firingCount).toBe(1);
    // Two failures, not four events.
    expect(result.groups[0].firings[0].observedValue).toBe(2);
  });
});

describe('live evaluation', () => {
  it('evaluates enabled rules only and records their alerts once', async () => {
    for (let index = 0; index <= 8; index += 1) {
      db.run(
        `INSERT INTO quotaObservations(id, connectionId, provider, scope, source, observationKind,
           unit, remaining, "limit", percentage, observedAt, capturedAt, confidence)
         VALUES(?, 'conn-1', 'anthropic', 'session (5h)', 'headers', 'observed',
           'requests', 5, 100, NULL, ?, ?, 'fresh')`,
        [
          `obs-${index}`,
          new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 2 * 60_000).toISOString(),
          new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 2 * 60_000).toISOString(),
        ]
      );
    }
    const enabled = await repo.createRule(RULE);
    await repo.createRule({ ...RULE, name: 'Disabled rule', enabled: false });

    const window = { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' };
    const first = await repo.evaluateEnabledRules(window);
    expect(first.evaluated).toBe(1);
    expect(first.fired).toBe(1);
    expect(first.events[0].ruleId).toBe(enabled.id);

    // Running again does not duplicate the open alert.
    const second = await repo.evaluateEnabledRules(window);
    expect(second.fired).toBe(0);
    expect(await repo.listRuleEvents({})).toHaveLength(1);
  });
});
