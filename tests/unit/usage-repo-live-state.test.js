// usageRepo live-state and read-path contracts the aggregate-focused suites
// leave uncovered: pending-request tracking, active sessions and their
// back-fill stamping, the endpoint backfill upsert, per-connection daily
// usage, history reads with masked keys, the 24h chart buckets, recent logs,
// and the spend window. Real SQLite in this file's isolated DATA_DIR.
import { describe, it, expect, beforeAll } from 'vitest';

const { DATA_FILE } = await import('../../src/lib/db/paths.js');
const { getAdapter } = await import('../../src/lib/db/driver.js');
const {
  statsEmitter,
  trackPendingRequest,
  trackActiveSession,
  getActiveSessions,
  getActiveRequests,
  buildRecentRequestRow,
  saveRequestUsage,
  getDailyConnectionUsage,
  getUsageHistory,
  resolveDayRange,
  getUsageStats,
  getUsageStatsInRange,
  getChartData,
  appendRequestLog,
  getRecentLogs,
  getSpendWindow,
  getProviderHealth,
} = await import('../../src/lib/db/repos/usageRepo.js');

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
let db;

beforeAll(async () => {
  expect(DATA_FILE.startsWith(process.env.DATA_DIR)).toBe(true);
  db = await getAdapter();
});

describe('buildRecentRequestRow masks keys and reads both row shapes', () => {
  it('parses string tokens/meta from a DB row and masks the api key', () => {
    const row = buildRecentRequestRow({
      timestamp: iso(1),
      model: 'm1',
      provider: 'p1',
      status: 'ok',
      tokens: JSON.stringify({ input_tokens: 7, output_tokens: 3 }),
      meta: JSON.stringify({ requestedModel: 'alias-m1', reasoningEffort: 'high' }),
      apiKey: 'sk-machineid-abcdef123456-crc9',
    });
    expect(row.promptTokens).toBe(7);
    expect(row.completionTokens).toBe(3);
    expect(row.requestedModel).toBe('alias-m1');
    expect(row.reasoningEffort).toBe('high');
    // 4-part sk key: keyId prefix only, machineId never shown.
    expect(row.apiKey).toMatch(/^sk-\*\*\*-/);
    expect(row.apiKey).not.toContain('machineid');
    expect(row.apiKey).not.toContain('abcdef123456');
  });

  it('masks short, long and absent keys without leaking material', () => {
    expect(buildRecentRequestRow({ tokens: {}, apiKey: 'tiny' }).apiKey).toBe('t***');
    const long = buildRecentRequestRow({
      tokens: {},
      apiKey: 'sk-random8key-extra-long-material',
    }).apiKey;
    expect(long.endsWith('***')).toBe(true);
    expect(long.length).toBeLessThan('sk-random8key-extra-long-material'.length);
    expect(buildRecentRequestRow({ tokens: {}, apiKey: null }).apiKey).toBeNull();
  });
});

describe('pending requests and active sessions', () => {
  it('tracks start/stop per model and account, and exposes them via getActiveRequests', async () => {
    trackPendingRequest('m-live', 'prov-live', 'conn-live', true);
    trackPendingRequest('m-live', 'prov-live', 'conn-live', true);
    let { activeRequests } = await getActiveRequests();
    const mine = activeRequests.find((r) => r.model === 'm-live');
    expect(mine).toMatchObject({ provider: 'prov-live', count: 2 });

    trackPendingRequest('m-live', 'prov-live', 'conn-live', false);
    trackPendingRequest('m-live', 'prov-live', 'conn-live', false);
    ({ activeRequests } = await getActiveRequests());
    expect(activeRequests.find((r) => r.model === 'm-live')).toBeUndefined();
    // Never negative: a stray extra stop clamps at zero rather than underflowing.
    trackPendingRequest('m-live', 'prov-live', 'conn-live', false);
    ({ activeRequests } = await getActiveRequests());
    expect(activeRequests.find((r) => r.model === 'm-live')).toBeUndefined();
  });

  it('debounced stats events actually fire', async () => {
    const fired = new Promise((resolve) => statsEmitter.once('pending', resolve));
    trackPendingRequest('m-evt', 'prov-evt', null, true);
    trackPendingRequest('m-evt', 'prov-evt', null, false);
    await fired;
  });

  it('an active session is stamped by saveRequestUsage and an error stop marks it', async () => {
    const okId = trackActiveSession({
      clientId: 'c1',
      model: 'm-sess',
      provider: 'Prov-S',
      connectionId: 'conn-s',
    });
    expect(typeof okId).toBe('string');
    await saveRequestUsage({
      timestamp: iso(0),
      provider: 'prov-s',
      model: 'm-sess',
      connectionId: 'conn-s',
      tokens: { prompt_tokens: 11, completion_tokens: 4 },
    });
    let rows = await getActiveSessions();
    const done = rows.find((r) => r.requestId === okId);
    expect(done).toMatchObject({
      promptTokens: 11,
      completionTokens: 4,
      status: 'done',
      provider: 'prov-s',
      connectionId: 'conn-s',
    });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);

    // A distinct model, so the FIFO stamp cannot land on the done row above.
    const errId = trackActiveSession({
      model: 'm-sess-err',
      provider: 'prov-s',
      connectionId: 'conn-s',
    });
    trackPendingRequest('m-sess-err', 'prov-s', 'conn-s', false, true);
    rows = await getActiveSessions();
    expect(rows.find((r) => r.requestId === errId).status).toBe('error');
    // Newest session first.
    const started = rows.map((r) => r.startedAt);
    expect([...started].sort((a, b) => b - a)).toEqual(started);
    // The error provider flag surfaces through the stats snapshots.
    const { errorProvider } = await getActiveRequests();
    expect(errorProvider).toBe('prov-s');
  });
  it('keeps absent account identity null instead of resolving by a display label', async () => {
    const requestId = trackActiveSession({ model:'unattributed-model',provider:'prov-s' });
    const rows = await getActiveSessions();
    expect(rows.find(row => row.requestId === requestId)).toMatchObject({ connectionId:null,account:null });
  });
});

describe('saveRequestUsage endpoint backfill', () => {
  it('a second save carrying the endpoint completes the endpoint-less row instead of inserting', async () => {
    const ts = iso(2);
    const entry = {
      timestamp: ts, requestId: 'same-physical-attempt',
      provider: 'prov-bf',
      model: 'm-bf',
      connectionId: 'conn-bf',
      tokens: { prompt_tokens: 5, completion_tokens: 2 },
      reasoningEffort: 'high',
    };
    await saveRequestUsage({ ...entry });
    const lifetimeAfterInsert = db.get(
      `SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`
    ).value;
    await saveRequestUsage({ ...entry, endpoint: '/v1/messages' });
    const rows = db.all(`SELECT endpoint FROM usageHistory WHERE model = 'm-bf'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe('/v1/messages');
    // The backfill is the same request arriving again: no second lifetime tick.
    expect(db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`).value).toBe(
      lifetimeAfterInsert
    );
  });
});

describe('per-connection daily usage', () => {
  it('returns zeros without a connectionId and sums only that connection today', async () => {
    expect(await getDailyConnectionUsage(null)).toEqual({ requests: 0, tokens: 0, resetAt: null });
    await saveRequestUsage({
      timestamp: iso(1),
      provider: 'prov-d',
      model: 'm-d',
      connectionId: 'conn-daily',
      tokens: { prompt_tokens: 20, completion_tokens: 10 },
    });
    const usage = await getDailyConnectionUsage('conn-daily');
    expect(usage.requests).toBe(1);
    expect(usage.tokens).toBe(30);
    // resetAt is tomorrow's local midnight, strictly in the future.
    expect(new Date(usage.resetAt).getTime()).toBeGreaterThan(Date.now());
    expect(await getDailyConnectionUsage('conn-never')).toMatchObject({ requests: 0, tokens: 0 });
  });
});

describe('getUsageHistory', () => {
  it('filters by provider/model/dates and masks the key on the way out', async () => {
    await saveRequestUsage({
      timestamp: iso(3),
      provider: 'prov-h',
      model: 'm-h',
      apiKey: 'sk-mach-keyidabc123-crc',
      tokens: { prompt_tokens: 9, completion_tokens: 1 },
    });
    const all = await getUsageHistory({
      provider: 'prov-h',
      model: 'm-h',
      startDate: iso(10),
      endDate: iso(0),
    });
    expect(all).toHaveLength(1);
    expect(all[0].tokens.prompt_tokens).toBe(9);
    expect(all[0].apiKeyMasked).toMatch(/^sk-\*\*\*-/);
    expect(JSON.stringify(all[0])).not.toContain('keyidabc123');
    expect(await getUsageHistory({ provider: 'no-such-provider' })).toEqual([]);
  });
});

describe('resolveDayRange', () => {
  it('parses bare local days, defaults end to start, rejects backwards and garbage', () => {
    const one = resolveDayRange({ startDate: '2026-08-30' });
    expect(one.startKey).toBe('2026-08-30');
    expect(one.endKey).toBe('2026-08-30');
    expect(new Date(one.endIso).getTime()).toBeGreaterThan(new Date(one.startIso).getTime());
    expect(resolveDayRange(null)).toBeNull();
    expect(resolveDayRange({ startDate: 'not-a-date' })).toBeNull();
    expect(resolveDayRange({ startDate: '2026-08-30', endDate: '2026-08-01' })).toBeNull();
  });
});

describe('stats and chart conservation over live rows', () => {
  it('period snapshots agree: today/24h live-history totals match the all-time rollup for fresh rows', async () => {
    const [allStats, todayStats, dayStats] = [
      await getUsageStats('all'),
      await getUsageStats('24h'),
      await getUsageStats('today'),
    ];
    // Everything this file wrote is minutes old, so every period sees it.
    expect(todayStats.totalRequests).toBe(allStats.totalRequests);
    expect(dayStats.totalPromptTokens).toBe(allStats.totalPromptTokens);
    expect(allStats.period).toBe('all');
    expect(todayStats.period).toBe('24h');
    // Requests reconcile across dimensions within one snapshot.
    const sum = (dim) => Object.values(dim).reduce((a, b) => a + (b.requests || 0), 0);
    expect(sum(allStats.byModel)).toBe(allStats.totalRequests);
    expect(sum(todayStats.byModel)).toBe(todayStats.totalRequests);
    // byReasoning carried the effort split written above.
    const dayRow = db.get(`SELECT data FROM usageDaily ORDER BY dateKey DESC LIMIT 1`);
    expect(JSON.parse(dayRow.data).byReasoning).toBeDefined();
  });

  it('an explicit range snapshot equals the period snapshot when the range covers today', async () => {
    const todayKey = resolveDayRange({ startDate: new Date().toISOString() }).startKey;
    const ranged = await getUsageStatsInRange('all', { startDate: todayKey, endDate: todayKey });
    const whole = await getUsageStats('all');
    expect(ranged.period).toBe('range');
    expect(ranged.range).toEqual({ startDate: todayKey, endDate: todayKey });
    expect(ranged.totalRequests).toBe(whole.totalRequests);
  });

  it('chart buckets conserve tokens for 24h, today, all and an explicit range', async () => {
    const expected = db.get(
      `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS t FROM usageHistory WHERE timestamp >= ?`,
      [new Date(now - 24 * 3600000).toISOString()]
    ).t;
    for (const period of ['24h', 'today']) {
      const buckets = await getChartData(period);
      expect(buckets).toHaveLength(24);
      expect(
        buckets.every((b) => typeof b.bucketStart === 'number' && typeof b.label === 'string')
      ).toBe(true);
      expect(buckets.reduce((a, b) => a + b.tokens, 0)).toBe(expected);
    }
    const allBuckets = await getChartData('all');
    expect(allBuckets.reduce((a, b) => a + b.tokens, 0)).toBe(expected);
    const week = await getChartData('7d');
    expect(week).toHaveLength(7);
    expect(week.reduce((a, b) => a + b.tokens, 0)).toBe(expected);
    const todayKey = resolveDayRange({ startDate: new Date().toISOString() }).startKey;
    const ranged = await getChartData('7d', { startDate: todayKey, endDate: todayKey });
    expect(ranged.reduce((a, b) => a + b.tokens, 0)).toBe(expected);
  });
});

describe('logs, spend, health', () => {
  it('appendRequestLog is a no-op and getRecentLogs derives pipe-delimited lines from usageHistory', async () => {
    await appendRequestLog('anything');
    const logs = await getRecentLogs(5);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.length).toBeLessThanOrEqual(5);
    // ts | model | PROVIDER | account | sent | received | status
    const parts = logs[0].split(' | ');
    expect(parts).toHaveLength(7);
    expect(parts[2]).toBe(parts[2].toUpperCase());
  });

  it('getSpendWindow reports the sample count with the sum', async () => {
    const w = await getSpendWindow(iso(60));
    expect(w.samples).toBe(
      db.get(`SELECT COUNT(*) AS c FROM usageHistory WHERE timestamp >= ?`, [iso(60)]).c
    );
    expect(w.spendUsd).toBeGreaterThanOrEqual(0);
    expect((await getSpendWindow(new Date(now + 3600000).toISOString())).samples).toBe(0);
  });

  it('getProviderHealth falls back to the account grain on an unknown groupBy and never claims unmeasured latency', async () => {
    const h = await getProviderHealth({ period: '7d', groupBy: 'nonsense' });
    expect(h.groupBy).toBe('account');
    for (const r of h.rows) {
      if (r.latencySamples === 0) expect(r.avgLatencyMs).toBeNull();
      if (r.requests > 0) expect(r.successRate).toBeGreaterThanOrEqual(0);
    }
    const byModel = await getProviderHealth({ groupBy: 'model' });
    expect(byModel.rows.every((r) => 'model' in r && 'connectionId' in r)).toBe(true);
  });
});
