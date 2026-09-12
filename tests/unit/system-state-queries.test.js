import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The route contract test mocks the repositories, so it proves the envelope and
// never the SQL. This file runs the real read-only queries against a real
// SQLite file in a throwaway DATA_DIR — never ~/.tokenproxy — so the query plans,
// the percentile arithmetic and the empty-database behaviour are exercised on
// the driver the app actually uses.

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-system-state-'));
process.env.DATA_DIR = TEMP_DATA_DIR;

const { DATA_FILE } = await import('../../src/lib/db/paths.js');
const { getAdapter } = await import('../../src/lib/db/driver.js');
const { getTrafficWindow } = await import('../../src/lib/db/repos/requestStatsRepo.js');
const { getSpendWindow } = await import('../../src/lib/db/repos/usageRepo.js');
const { getFailoverWindow } = await import('../../src/lib/db/repos/accountSwitchRepo.js');
const { getUpstreamHealthCounts, getUpstreamHealthSummary, isConnectionDegraded } =
  await import('../../src/lib/db/repos/connectionsRepo.js');
const { createProviderConnection } = await import('../../src/lib/db/repos/connectionsRepo.js');

const HOUR_MS = 3600 * 1000;
const now = Date.now();
const sinceIso = new Date(now - HOUR_MS).toISOString();

let db;

// Hard gate: DATA_DIR resolution silently falls back to ~/.tokenproxy when the
// configured directory is unusable, and this suite writes rows. Refuse to run
// anywhere but the temp directory rather than corrupting a real install.
beforeAll(async () => {
  expect(DATA_FILE.startsWith(TEMP_DATA_DIR)).toBe(true);
  db = await getAdapter();
});

beforeEach(() => {
  db.run(`DELETE FROM requestStats`);
  db.run(`DELETE FROM usageHistory`);
  db.run(`DELETE FROM providerConnections`);
  db.run(`DELETE FROM accountSwitches`);
});

function insertStat(id, { minutesAgo, status = 'success', latency = 0 }) {
  db.run(
    `INSERT INTO requestStats(id, timestamp, provider, model, connectionId, status, latencyTotal)
     VALUES(?, ?, 'openai', 'gpt-4', 'conn-1', ?, ?)`,
    [id, new Date(now - minutesAgo * 60000).toISOString(), status, latency]
  );
}

describe('getTrafficWindow against a real SQLite file', () => {
  it('answers an empty table without inventing a percentile', async () => {
    const result = await getTrafficWindow(sinceIso);
    expect(result).toEqual({
      requests: 0,
      errors: 0,
      latencySamples: 0,
      latencyPercentileMs: null,
      lastEventAt: null,
    });
  });

  it('counts only rows inside the window and reports the newest event unbounded', async () => {
    // 100 in-window rows with latencies 10..1000ms, 5 of them errors.
    for (let i = 1; i <= 100; i++) {
      insertStat(`in-${i}`, {
        minutesAgo: 30,
        status: i <= 5 ? 'error' : 'success',
        latency: i * 10,
      });
    }
    // Outside the window, and one row whose latency was never measured.
    insertStat('old-1', { minutesAgo: 300, status: 'error', latency: 5000 });
    insertStat('unmeasured', { minutesAgo: 10, status: 'success', latency: 0 });

    const result = await getTrafficWindow(sinceIso);
    expect(result.requests).toBe(101);
    expect(result.errors).toBe(5);

    // The zero-latency row is excluded rather than counted as an instant response.
    expect(result.latencySamples).toBe(100);

    // Nearest rank: ceil(0.95 * 100) = 95th smallest of 10..1000 → 950ms.
    expect(result.latencyPercentileMs).toBe(950);

    // Freshness looks past the window, so an idle instance is distinguishable
    // from one with no telemetry at all.
    expect(Date.parse(result.lastEventAt)).toBeGreaterThan(now - 11 * 60000);
  });

  it('returns a null percentile when every row in the window is unmeasured', async () => {
    db.run(`DELETE FROM requestStats`);
    insertStat('flat-1', { minutesAgo: 5, latency: 0 });
    insertStat('flat-2', { minutesAgo: 5, latency: 0 });

    const result = await getTrafficWindow(sinceIso);
    expect(result.requests).toBe(2);
    expect(result.latencySamples).toBe(0);
    expect(result.latencyPercentileMs).toBeNull();
  });

  it('is served by idx_rs_ts rather than a table scan', async () => {
    const counters = db
      .all(
        `EXPLAIN QUERY PLAN
         SELECT COUNT(*) AS requests,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN latencyTotal > 0 THEN 1 ELSE 0 END) AS latencySamples
         FROM requestStats WHERE timestamp >= ?`,
        [sinceIso]
      )
      .map((r) => r.detail)
      .join(' ');
    expect(counters).toMatch(/idx_rs_ts/);
    expect(counters).not.toMatch(/SCAN requestStats(?! USING)/);

    const percentile = db
      .all(
        `EXPLAIN QUERY PLAN
         SELECT latencyTotal FROM requestStats
         WHERE timestamp >= ? AND latencyTotal > 0
         ORDER BY latencyTotal ASC LIMIT 1 OFFSET ?`,
        [sinceIso, 0]
      )
      .map((r) => r.detail)
      .join(' ');
    expect(percentile).toMatch(/idx_rs_ts/);
  });
});

describe('getSpendWindow against a real SQLite file', () => {
  it('labels estimate-only spend and never turns unknown pricing into zero spend', async () => {
    expect(await getSpendWindow(sinceIso)).toEqual({
      spendUsd: null,
      samples: 0,
      pricedSamples: 0,
      providerReportedUsd: null,
      providerReportedSamples: 0,
      estimatedUsd: null,
      estimatedSamples: 0,
      unknownSamples: 0,
      evidenceKind: 'unknown',
    });

    const insert = (minutesAgo, cost, costSource, estimatedCostUsd = null) =>
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, cost, status, costSource, estimatedCostUsd)
         VALUES(?, 'openai', 'gpt-4', ?, 'ok', ?, ?)`,
        [new Date(now - minutesAgo * 60000).toISOString(), cost, costSource, estimatedCostUsd]
      );
    insert(10, 1.5, 'application-estimate', 1.5);
    insert(20, 2.25, 'application-estimate', 2.25);
    insert(5, 0, 'unknown');
    insert(4, null, 'application-estimate');
    insert(300, 99, 'provider-reported'); // outside the window

    const result = await getSpendWindow(sinceIso);
    expect(result.spendUsd).toBeCloseTo(3.75, 10);
    expect(result).toMatchObject({
      samples: 4,
      pricedSamples: 2,
      providerReportedUsd: null,
      providerReportedSamples: 0,
      estimatedUsd: 3.75,
      estimatedSamples: 2,
      unknownSamples: 2,
      evidenceKind: 'application-estimate',
    });
  });

  it('is served by idx_uh_ts rather than a table scan', async () => {
    const plan = db
      .all(
        `EXPLAIN QUERY PLAN
         SELECT COALESCE(SUM(cost), 0) AS spendUsd, COUNT(*) AS samples
         FROM usageHistory WHERE timestamp >= ?`,
        [sinceIso]
      )
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toMatch(/idx_uh_ts/);
  });
});

describe('getFailoverWindow against a real SQLite file', () => {
  it('counts exhaustion and unavailable switches without calling the first pin a failover', async () => {
    const insert = (id, trigger, fromConnectionId, minutesAgo) =>
      db.run(
        `INSERT INTO accountSwitches(id, sessionHash, model, fromConnectionId, toConnectionId,
           trigger, switchedAt) VALUES(?, 'session', 'model', ?, 'next', ?, ?)`,
        [id, fromConnectionId, trigger, new Date(now - minutesAgo * 60000).toISOString()]
      );
    insert('first', 'first-pin', null, 30);
    insert('exhausted', 'exhaustion', 'first', 20);
    insert('unavailable', 'unavailable', 'next', 10);
    insert('future-vocabulary', 'future-trigger', 'next', 5);
    insert('old', 'exhaustion', 'first', 300);

    expect(await getFailoverWindow(sinceIso)).toEqual({
      failovers: 2,
      knownNonFailovers: 1,
      unknownTriggers: 1,
      samples: 4,
    });
  });

  it('uses the account switch timestamp index', async () => {
    const plan = db
      .all(
        `EXPLAIN QUERY PLAN SELECT trigger, fromConnectionId
         FROM accountSwitches WHERE switchedAt >= ?`,
        [sinceIso]
      )
      .map((row) => row.detail)
      .join(' ');
    expect(plan).toMatch(/idx_as_at/);
  });
});

describe('upstream health counts', () => {
  it('classifies a connection as degraded only on a persisted error signal', () => {
    expect(isConnectionDegraded({ testStatus: 'active' }, now)).toBe(false);
    expect(isConnectionDegraded({ testStatus: 'unavailable' }, now)).toBe(true);
    expect(isConnectionDegraded({ testStatus: 'expired' }, now)).toBe(true);
    expect(isConnectionDegraded({ testStatus: 'error' }, now)).toBe(true);
    expect(isConnectionDegraded({ errorCode: 429 }, now)).toBe(true);
    expect(
      isConnectionDegraded({ rateLimitedUntil: new Date(now + 60000).toISOString() }, now)
    ).toBe(true);
    // An expired cooldown is not degradation.
    expect(
      isConnectionDegraded({ rateLimitedUntil: new Date(now - 60000).toISOString() }, now)
    ).toBe(false);
    expect(isConnectionDegraded({ rateLimitedUntil: 'not-a-date' }, now)).toBe(false);
    expect(isConnectionDegraded(null, now)).toBe(false);
  });

  it('keeps persisted failures degraded even when the connection is disabled', async () => {
    expect(await getUpstreamHealthCounts(now)).toEqual({ total: 0, connected: 0, degraded: 0 });

    await createProviderConnection({
      provider: 'openai',
      authType: 'apikey',
      name: 'healthy',
      testStatus: 'active',
    });
    await createProviderConnection({
      provider: 'anthropic',
      authType: 'apikey',
      name: 'broken',
      testStatus: 'unavailable',
      errorCode: 429,
    });
    await createProviderConnection({
      provider: 'gemini',
      authType: 'apikey',
      name: 'off',
      isActive: false,
      testStatus: 'reauth_required',
      errorCode: 401,
    });

    const counts = await getUpstreamHealthCounts(now);
    expect(counts.total).toBe(3);
    expect(counts.connected).toBe(2);
    expect(counts.degraded).toBe(2);
  });

  it('classifies persisted 429 as rate-limited and returns no connection data', async () => {
    await createProviderConnection({
      provider: 'anthropic',
      authType: 'apikey',
      name: 'broken',
      testStatus: 'unavailable',
      errorCode: 429,
    });
    await createProviderConnection({
      provider: 'gemini',
      authType: 'apikey',
      name: 'off',
      isActive: false,
      testStatus: 'reauth_required',
      errorCode: 401,
    });

    const summary = await getUpstreamHealthSummary(now);

    expect(summary).toMatchObject({
      total: 2,
      connected: 1,
      degraded: 2,
      degradedProviders: [
        {
          provider: 'anthropic',
          degradedConnections: 1,
          likelyCauses: ['rate_limited'],
        },
        {
          provider: 'gemini',
          degradedConnections: 1,
          likelyCauses: ['authentication'],
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('broken');
    expect(JSON.stringify(summary)).not.toContain('429');
  });
});
