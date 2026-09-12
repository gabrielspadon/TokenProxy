import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const priorDataDir = process.env.DATA_DIR;
const oldTime = '2023-11-14T00:00:00.000Z';
const fixtureKey = 'history-retention-fixture-key';
let tempDir, db, saveRequestStats, ingestContextEvent, cleanupContext, retentionDays, validateAnalyticsQuery;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-history-retention-'));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import('../../src/lib/db/driver.js');
  db = await getAdapter();
  ({ saveRequestStats } = await import('../../src/lib/db/repos/requestStatsRepo.js'));
  ({ ingestContextEvent } = await import('../../src/lib/db/repos/contextClientEventsRepo.js'));
  ({ cleanupContext, retentionDays } = await import('../../src/lib/db/repos/contextRepo.js'));
  ({ validateAnalyticsQuery } = await import('../../src/lib/db/analytics/contextQueries.mjs'));
  db.run('INSERT INTO apiKeys(id,key,createdAt) VALUES(?,?,?)', ['fixture-key-id', fixtureKey, oldTime]);
  db.run('INSERT INTO contextSessions(id,sessionHash,identitySource,firstSeenAt,lastSeenAt) VALUES(?,?,?,?,?)',
    [1, 'fixture-session', 'explicit', oldTime, oldTime]);
  db.run('INSERT INTO requestStats(id,timestamp,contextSessionId) VALUES(?,?,?)', ['old-request', oldTime, 1]);
  db.run('INSERT INTO contextStages(requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk) VALUES(?,?,?,?,?,?,?,?)',
    ['old-request', 0, 'fixture-stage', 100, 90, -10, 'applied', 'none']);
  db.run('INSERT INTO contextStructures(requestId,boundary,version,data) VALUES(?,?,?,?)',
    ['old-request', 'fixture-boundary', 1, '{}']);
  db.run('INSERT INTO contextClientEvents(id,clientKeyId,clientEventId,occurredAt,recordedAt,type,requestId,contextSessionId,clientRef,payloadHash) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ['old-event', 'fixture-key-id', randomUUID(), oldTime, oldTime, 'task_start', 'old-request', 1, 'fixture-client', 'fixture-hash']);
  db.run('INSERT INTO usageHistory(timestamp,connectionId,promptTokens) VALUES(?,?,?)', [oldTime, 'historical-account', 71]);
  db.run('INSERT INTO costLedger(id,ts,baselineUsd,actualUsd,savedUsd) VALUES(?,?,?,?,?)', ['old-ledger', oldTime, 2, 1, 1]);
});

afterEach(async () => {
  await globalThis._contextAnalytics?.client.close();
  delete globalThis._contextAnalytics;
  db?.close?.();
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (priorDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = priorDataDir;
});

function settings(value) {
  db.run('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [JSON.stringify(value)]);
}

function historicalEvidence() {
  return {
    request: db.get('SELECT * FROM requestStats WHERE id=?', ['old-request']),
    stage: db.get('SELECT * FROM contextStages WHERE requestId=?', ['old-request']),
    structure: db.get('SELECT * FROM contextStructures WHERE requestId=?', ['old-request']),
    session: db.get('SELECT * FROM contextSessions WHERE id=?', [1]),
    event: db.get('SELECT * FROM contextClientEvents WHERE id=?', ['old-event']),
    usage: db.get('SELECT * FROM usageHistory WHERE connectionId=?', ['historical-account']),
    ledger: db.get('SELECT * FROM costLedger WHERE id=?', ['old-ledger']),
  };
}

function event(occurredAt = new Date().toISOString()) {
  return { eventId: randomUUID(), occurredAt, type: 'task_start', clientId: 'fixture-client', taskId: 'fixture-task' };
}

describe('explicit history retention policy', () => {
  it.each([{}, { statsRetentionDays: 45 }, { statsRetentionMode: 'preserve', statsRetentionDays: 1 }])(
    'keeps every old evidence row byte-for-byte on the first request with %j', async (policy) => {
      settings(policy);
      const before = historicalEvidence();
      await saveRequestStats({ id: 'new-request', timestamp: new Date().toISOString(), status: 'success', tokens: { prompt_tokens: 2 } });
      expect(db.get('SELECT id FROM requestStats WHERE id=?', ['new-request'])).toBeTruthy();
      expect(historicalEvidence()).toEqual(before);
      const { getContextOverview } = await import('../../src/lib/db/repos/contextRepo.js');
      const overview = await getContextOverview({ view: 'summary' });
      expect(overview.retentionDays).toBeNull();
      expect(overview.recording.totalRetainedAttempts).toBe(2);
    },
  );

  it('deletes expired Context evidence only after explicit window selection while retaining usage', async () => {
    settings({ statsRetentionMode: 'window', statsRetentionDays: 45 });
    const usage = historicalEvidence().usage;
    const ledger = historicalEvidence().ledger;
    await saveRequestStats({ id: 'new-request', timestamp: new Date().toISOString(), status: 'success' });
    const evidence = historicalEvidence();
    for (const name of ['request', 'stage', 'structure', 'session', 'event']) expect(evidence[name]).toBeFalsy();
    expect(evidence.usage).toEqual(usage);
    expect(evidence.ledger).toEqual(ledger);
    expect(db.get('SELECT id FROM requestStats WHERE id=?', ['new-request'])).toBeTruthy();
  });

  it('preserves old events in event-only ingestion and accepts historical reports without attribution guesses', async () => {
    settings({ statsRetentionDays: 45 });
    const before = historicalEvidence();
    const saved = await ingestContextEvent(fixtureKey, event(oldTime));
    expect(saved.event.occurredAt).toBe(oldTime);
    expect(saved.event.requestId).toBeNull();
    expect(saved.event.contextSessionId).toBeNull();
    expect(historicalEvidence()).toEqual(before);
    expect(db.get('SELECT COUNT(*) AS n FROM contextClientEvents').n).toBe(2);
    await expect(ingestContextEvent(fixtureKey, event(new Date(Date.now() + 600000).toISOString())))
      .rejects.toThrow('outside the retained observation window');
  });

  it('applies an explicit window to event-only ingestion and rejects expired incoming reports', async () => {
    settings({ statsRetentionMode: 'window', statsRetentionDays: 45 });
    await expect(ingestContextEvent(fixtureKey, event(oldTime))).rejects.toThrow('outside the retained observation window');
    await ingestContextEvent(fixtureKey, event());
    expect(db.get('SELECT id FROM contextClientEvents WHERE id=?', ['old-event'])).toBeFalsy();
    expect(db.get('SELECT COUNT(*) AS n FROM contextClientEvents').n).toBe(1);
  });

  it('carries indefinite retention through analytics and requires a deliberate window mode', () => {
    expect(retentionDays({})).toBeNull();
    expect(retentionDays({ statsRetentionDays: 45 })).toBeNull();
    expect(retentionDays({ statsRetentionMode: 'unexpected', statsRetentionDays: 1 })).toBeNull();
    expect(retentionDays({ statsRetentionMode: 'window', statsRetentionDays: 30 })).toBe(30);
    expect(validateAnalyticsQuery({ operation: 'overview', filter: {}, retainedDays: null }).retainedDays).toBeNull();
    expect(() => validateAnalyticsQuery({ operation: 'overview', filter: {}, retainedDays: 0 })).toThrow('Invalid retention');
  });

  it('keeps the exact cutoff and newer rows across every named Context store while preserving Usage and Economics history', () => {
    const now = Date.parse('2026-09-12T12:00:00.000Z');
    const cutoff = new Date(now - 45 * 86400000).toISOString();
    const recent = new Date(now - 86400000).toISOString();
    for (const [id, hash, at] of [[2, 'cutoff-session', cutoff], [3, 'recent-session', recent]]) {
      const request = `${hash}-request`;
      db.run('INSERT INTO contextSessions(id,sessionHash,identitySource,firstSeenAt,lastSeenAt) VALUES(?,?,?,?,?)', [id, hash, 'explicit', at, at]);
      db.run('INSERT INTO requestStats(id,timestamp,contextSessionId) VALUES(?,?,?)', [request, at, id]);
      db.run('INSERT INTO contextStages(requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk) VALUES(?,?,?,?,?,?,?,?)', [request, 0, 'fixture-stage', 10, 9, -1, 'applied', 'none']);
      db.run('INSERT INTO contextStructures(requestId,boundary,version,data) VALUES(?,?,?,?)', [request, 'fixture-boundary', 1, '{}']);
      db.run('INSERT INTO contextClientEvents(id,clientKeyId,clientEventId,occurredAt,recordedAt,type,requestId,contextSessionId,clientRef,payloadHash) VALUES(?,?,?,?,?,?,?,?,?,?)', [`${hash}-event`, 'fixture-key-id', randomUUID(), at, at, 'task_start', request, id, 'fixture-client', `${hash}-digest`]);
    }

    cleanupContext(db, now, 45);

    expect(historicalEvidence()).toMatchObject({
      request: undefined, stage: undefined, structure: undefined, session: undefined, event: undefined,
      usage: expect.objectContaining({ connectionId: 'historical-account' }),
      ledger: expect.objectContaining({ id: 'old-ledger' }),
    });
    for (const hash of ['cutoff-session', 'recent-session']) {
      const request = `${hash}-request`;
      expect(db.get('SELECT id FROM requestStats WHERE id=?', [request])).toBeTruthy();
      expect(db.get('SELECT requestId FROM contextStages WHERE requestId=?', [request])).toBeTruthy();
      expect(db.get('SELECT requestId FROM contextStructures WHERE requestId=?', [request])).toBeTruthy();
      expect(db.get('SELECT id FROM contextClientEvents WHERE id=?', [`${hash}-event`])).toBeTruthy();
      expect(db.get('SELECT id FROM contextSessions WHERE sessionHash=?', [hash])).toBeTruthy();
    }
  });
});
