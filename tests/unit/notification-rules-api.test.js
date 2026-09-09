// The admin surface for notification rules. Verifies the revision conflict
// reaches the caller as 409 with the live rule attached, that a dry run writes
// nothing, and that the catalogue travels with the list including the
// conditions this build cannot honestly support.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir;
let db;
const originalDataDir = process.env.DATA_DIR;

vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: async () => null }));

const RULE = {
  name: 'Session quota low',
  conditionKind: 'quota_risk',
  scopeKind: 'connection',
  scopeId: 'conn-1',
  threshold: 10,
  durationSeconds: 600,
  cooldownSeconds: 3600,
};

const post = (url, body) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-notifapi-'));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete globalThis._contextAnalytics;
  vi.resetModules();
  const { getAdapter } = await import('@/lib/db/driver.js');
  db = await getAdapter();
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

describe('GET /api/admin/notification-rules', () => {
  it('returns the condition catalogue and the unavailable conditions with reasons', async () => {
    const { GET } = await import('@/app/api/admin/notification-rules/route.js');
    const response = await GET(new Request('http://localhost/api/admin/notification-rules'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rules).toEqual([]);
    expect(body.conditions.map((condition) => condition.kind).sort()).toEqual([
      'compatibility_regression',
      'compression_saver_failure',
      'operation_failure',
      'quota_risk',
      'repeated_fallback',
      'stale_telemetry',
    ]);
    expect(body.unavailableConditions.some(entry => entry.kind === 'compression_saver_failure')).toBe(false);
  });
});

describe('rule mutation', () => {
  it('creates a rule and rejects an unsupported condition with 400', async () => {
    const { POST } = await import('@/app/api/admin/notification-rules/route.js');
    const created = await POST(post('http://localhost/api/admin/notification-rules', RULE));
    expect(created.status).toBe(201);
    expect((await created.json()).revision).toBe(1);

    const bad = await POST(
      post('http://localhost/api/admin/notification-rules', {
        ...RULE,
        conditionKind: 'unrecorded_condition',
      })
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_rule');
  });

  it('surfaces a revision conflict as 409 carrying the live rule', async () => {
    const { POST } = await import('@/app/api/admin/notification-rules/route.js');
    const { PUT } = await import('@/app/api/admin/notification-rules/[id]/route.js');
    const rule = await (
      await POST(post('http://localhost/api/admin/notification-rules', RULE))
    ).json();

    const accepted = await PUT(
      post(`http://localhost/api/admin/notification-rules/${rule.id}`, {
        ...RULE,
        threshold: 5,
        revision: 1,
      }),
      { params: Promise.resolve({ id: rule.id }) }
    );
    expect(accepted.status).toBe(200);

    // A second editor still holding revision 1.
    const stale = await PUT(
      post(`http://localhost/api/admin/notification-rules/${rule.id}`, {
        ...RULE,
        threshold: 25,
        revision: 1,
      }),
      { params: Promise.resolve({ id: rule.id }) }
    );
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe('revision_conflict');
    expect(body.expectedRevision).toBe(1);
    // The live state travels with the refusal so the operator sees the change.
    expect(body.current.revision).toBe(2);
    expect(body.current.threshold).toBe(5);
  });

  it('requires the caller to state a revision', async () => {
    const { POST } = await import('@/app/api/admin/notification-rules/route.js');
    const { PUT } = await import('@/app/api/admin/notification-rules/[id]/route.js');
    const rule = await (
      await POST(post('http://localhost/api/admin/notification-rules', RULE))
    ).json();
    const response = await PUT(
      post(`http://localhost/api/admin/notification-rules/${rule.id}`, { ...RULE }),
      { params: Promise.resolve({ id: rule.id }) }
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/admin/notification-rules/dry-run', () => {
  it('reports historical firings and writes nothing', async () => {
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
    const { POST } = await import('@/app/api/admin/notification-rules/dry-run/route.js');
    const response = await POST(
      post('http://localhost/api/admin/notification-rules/dry-run', {
        rule: RULE,
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-02T00:00:00.000Z',
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.firingCount).toBe(1);
    expect(body.groups[0].firings[0].refs).toContain('obs-0');
    // A dry run is a read.
    expect(db.get(`SELECT COUNT(*) AS c FROM notificationRuleEvents`).c).toBe(0);
    expect(db.get(`SELECT COUNT(*) AS c FROM notificationRules`).c).toBe(0);
  });

  it('rejects a malformed range rather than evaluating a partial population', async () => {
    const { POST } = await import('@/app/api/admin/notification-rules/dry-run/route.js');
    const response = await POST(
      post('http://localhost/api/admin/notification-rules/dry-run', {
        rule: RULE,
        start: 'yesterday',
      })
    );
    expect(response.status).toBe(400);
  });
});

describe('alert disposition', () => {
  it('acknowledges and snoozes, and refuses an unknown action', async () => {
    const { POST: createRoute } = await import('@/app/api/admin/notification-rules/route.js');
    const rule = await (
      await createRoute(post('http://localhost/api/admin/notification-rules', RULE))
    ).json();
    const repo = await import('@/lib/db/repos/notificationRulesRepo.js');
    const alert = await repo.recordFiring(
      rule,
      {
        firedAt: '2026-01-01T00:10:00.000Z',
        breachStartedAt: '2026-01-01T00:00:00.000Z',
        observedValue: 5,
        refs: ['obs-1'],
      },
      'conn-1::session'
    );

    const { POST } = await import('@/app/api/admin/notification-rules/events/[id]/route.js');
    const params = { params: Promise.resolve({ id: alert.id }) };

    const bad = await POST(
      post(`http://localhost/api/admin/notification-rules/events/${alert.id}`, { action: 'drain' }),
      params
    );
    expect(bad.status).toBe(400);

    const snoozed = await POST(
      post(`http://localhost/api/admin/notification-rules/events/${alert.id}`, {
        action: 'snooze',
        until: '2030-01-01T00:00:00.000Z',
      }),
      params
    );
    expect(snoozed.status).toBe(200);
    // Snooze does not resolve the alert.
    expect((await snoozed.json()).outcome).toBe('firing');

    const acknowledged = await POST(
      post(`http://localhost/api/admin/notification-rules/events/${alert.id}`, {
        action: 'acknowledge',
      }),
      params
    );
    expect(acknowledged.status).toBe(200);
    expect((await acknowledged.json()).outcome).toBe('acknowledged');

    // Acknowledging twice is refused, not silently re-stamped.
    const again = await POST(
      post(`http://localhost/api/admin/notification-rules/events/${alert.id}`, {
        action: 'acknowledge',
      }),
      params
    );
    expect(again.status).toBe(400);
  });
});
