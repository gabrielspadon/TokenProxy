// requestStatsRepo write/read contracts against the real SQLite adapter in
// this file's isolated DATA_DIR (setup-isolate-data-dir.js). Covers what
// stats-summary-honesty.test.js does not: the saveRequestStats upsert,
// buildStatsWhere time-window and multi-select filters, the usageHistory
// backfill, getStatsFilters cascading maps, and getStatsSeries bucketing.
import { describe, it, expect, beforeAll, vi } from 'vitest';

// These fixtures exercise production display behavior. Origin-boundary tests
// separately prove that actual test processes cannot self-label their rows.
vi.mock('../../src/lib/db/telemetryOrigin.js', () => ({ processTelemetryOrigin: () => 'production' }));

const { DATA_FILE } = await import('../../src/lib/db/paths.js');
const { getAdapter } = await import('../../src/lib/db/driver.js');
const {
  saveRequestStats,
  buildStatsWhere,
  getStatsFilters,
  getStatsSummary,
  getStatsSeries,
  getStatsItems,
  getTrafficWindow,
} = await import('../../src/lib/db/repos/requestStatsRepo.js');

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
let db;

beforeAll(async () => {
  // Hard gate: an unusable DATA_DIR silently falls back to ~/.tokenproxy.
  expect(DATA_FILE.startsWith(process.env.DATA_DIR)).toBe(true);
  db = await getAdapter();
});

describe('buildStatsWhere', () => {
  it('no caller filter still applies the shared visible population', () => {
    expect(buildStatsWhere({}).where).toContain('telemetryQuarantineRows');
    expect(buildStatsWhere({}).params).toEqual([]);
  });

  it('a scalar and an array both become IN clauses, empties are skipped', () => {
    const { where, params } = buildStatsWhere({
      provider: 'p1',
      model: ['m1', 'm2'],
      connectionId: [],
    });
    expect(where).toContain('provider IN (?)');
    expect(where).toContain('model IN (?, ?)');
    expect(where).not.toContain('connectionId');
    expect(params).toEqual(['p1', 'm1', 'm2']);
  });

  it('start/end dates become ISO-normalized timestamp bounds', () => {
    const { where, params } = buildStatsWhere({ startDate: '2026-01-01', endDate: '2026-02-01' });
    expect(where).toContain('timestamp >= ?');
    expect(where).toContain('timestamp <= ?');
    expect(params[0]).toBe(new Date('2026-01-01').toISOString());
    expect(params[1]).toBe(new Date('2026-02-01').toISOString());
  });
});

describe('saveRequestStats — the upsert is the streaming start/complete contract', () => {
  it('ignores a detail without an id and never throws on garbage', async () => {
    await saveRequestStats(null);
    await saveRequestStats({});
    await saveRequestStats('nope');
    expect(db.get(`SELECT COUNT(*) AS c FROM requestStats`).c).toBe(0);
  });

  it('inserts a row with canonicalized token fields and defaults', async () => {
    await saveRequestStats({
      id: 'req-1',
      timestamp: iso(10),
      provider: 'prov-a',
      model: 'model-a',
      connectionId: 'conn-a',
      tokens: {
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_tokens: 30,
        cache_creation_input_tokens: 5,
        reasoning_tokens: 7,
      },
      latency: { total: 900, ttft: 100 },
    });
    const row = db.get(`SELECT * FROM requestStats WHERE id = 'req-1'`);
    expect(row).toMatchObject({
      provider: 'prov-a',
      model: 'model-a',
      connectionId: 'conn-a',
      status: 'success', // default when the detail omits it
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 30,
      cacheCreationTokens: 5,
      reasoningTokens: 7,
      latencyTotal: 900,
      latencyTtft: 100,
    });
  });

  it('a second save with the same id updates the row in place (stream complete over stream start)', async () => {
    await saveRequestStats({
      id: 'req-2',
      timestamp: iso(9),
      provider: 'prov-a',
      model: 'model-a',
      status: 'pending',
    });
    await saveRequestStats({
      id: 'req-2',
      timestamp: iso(8),
      provider: 'prov-a',
      model: 'model-a',
      status: 'error',
      tokens: { prompt_tokens: 50, completion_tokens: 5 },
      latency: { total: 1500 },
    });
    expect(db.get(`SELECT COUNT(*) AS c FROM requestStats WHERE id = 'req-2'`).c).toBe(1);
    const row = db.get(`SELECT * FROM requestStats WHERE id = 'req-2'`);
    expect(row.status).toBe('error');
    expect(row.promptTokens).toBe(50);
    expect(row.latencyTotal).toBe(1500);
  });
});

describe('aggregation over the saved rows', () => {
  beforeAll(async () => {
    await saveRequestStats({
      id: 'req-3',
      timestamp: iso(200),
      provider: 'prov-b',
      model: 'model-b',
      connectionId: 'conn-b',
      tokens: { prompt_tokens: 10, completion_tokens: 1 },
    });
  });

  it('getStatsSummary sums tokens and splits input from cache reads/writes', async () => {
    const s = await getStatsSummary({ provider: 'prov-a' });
    // req-1 (100p/20c, 30 cached, 5 created) + req-2 (50p/5c).
    expect(s.totalRequests).toBe(2);
    expect(s.totalTokens).toBe(175);
    expect(s.outputTokens).toBe(25);
    expect(s.cacheReadTokens).toBe(30);
    expect(s.cacheCreationTokens).toBe(5);
    // input = prompt - cached - created, floored at 0 per row: (100-35) + 50.
    expect(s.inputTokens).toBe(115);
  });

  it('a time-window filter excludes rows outside it', async () => {
    const s = await getStatsSummary({ startDate: iso(30) });
    // req-3 sits 200 minutes back, outside the window.
    expect(s.totalRequests).toBe(2);
    const none = await getStatsSummary({ endDate: iso(300) });
    expect(none.totalRequests).toBe(0);
  });

  it('getStatsFilters returns the distinct dimensions with cascading linkage maps', async () => {
    const f = await getStatsFilters();
    expect(f.providers.map((p) => p.id).sort()).toEqual(['prov-a', 'prov-b']);
    expect(f.models).toContain('model-a');
    expect(f.models).toContain('model-b');
    expect(f.modelsByProvider['prov-b']).toEqual(['model-b']);
    expect(f.accountsByProvider['prov-b'].map((a) => a.id)).toEqual(['conn-b']);
    expect(f.modelsByAccount['conn-b']).toEqual(['model-b']);
  });

  it('getStatsFilters applies time bounds and caps distinct facet tuples', async () => {
    const bounded = await getStatsFilters({ startDate: iso(30), endDate: iso(0) });
    expect(bounded.providers.map((provider) => provider.id)).toEqual(['prov-a']);
    expect(bounded.models).toEqual(['model-a']);

    db.exec(`WITH RECURSIVE seq(n) AS (
      SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 5000
    )
    INSERT INTO requestStats(id, timestamp, provider, model, connectionId)
    SELECT 'facet-cap-' || n, '${iso(1)}', 'facet-provider', printf('facet-%04d', n), NULL FROM seq`);
    try {
      const capped = await getStatsFilters({ startDate: iso(2), endDate: iso(0) });
      expect(capped.models).toHaveLength(5000);
      expect(capped.models).not.toContain('facet-5000');
    } finally {
      db.run(`DELETE FROM requestStats WHERE id LIKE 'facet-cap-%'`);
    }
  });

  it('getStatsSeries returns [] with no matching rows and conserves totals when bucketing', async () => {
    expect(await getStatsSeries({ provider: 'no-such' })).toEqual([]);
    const series = await getStatsSeries({});
    expect(series.length).toBeGreaterThan(0);
    const summary = await getStatsSummary({});
    const agg = series.reduce(
      (a, b) => ({ requests: a.requests + b.requests, totalTokens: a.totalTokens + b.totalTokens }),
      { requests: 0, totalTokens: 0 }
    );
    // Every saved row lands in exactly one bucket: bucketed sums equal the
    // unbucketed summary, whatever width auto-granularity picked.
    expect(agg.requests).toBe(summary.totalRequests);
    expect(agg.totalTokens).toBe(summary.totalTokens);
    // Buckets carry labels and a per-bucket hit rate that is null, not 0, when idle.
    const idle = series.find((b) => b.requests === 0);
    if (idle) expect(idle.cacheHitRate).toBeNull();
  });

  it('getStatsItems paginates newest-first with an honest page envelope', async () => {
    const page1 = await getStatsItems({ page: 1, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.pagination).toMatchObject({
      page: 1,
      pageSize: 2,
      totalItems: 3,
      totalPages: 2,
      hasNext: true,
      hasPrev: false,
    });
    // Newest first.
    const ts = page1.items.map((i) => i.timestamp);
    expect([...ts].sort().reverse()).toEqual(ts);
    const page2 = await getStatsItems({ page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.pagination.hasPrev).toBe(true);
    expect(page2.pagination.hasNext).toBe(false);
  });

  it('getTrafficWindow counts errors and measured latencies inside the window only', async () => {
    const w = await getTrafficWindow(iso(30));
    // req-1 (measured, success) and req-2 (measured, error) are inside; req-3 is not.
    expect(w.requests).toBe(2);
    expect(w.errors).toBe(1);
    expect(w.latencySamples).toBe(2);
    // p95 nearest-rank over [900, 1500] is the 2nd smallest.
    expect(w.latencyPercentileMs).toBe(1500);
    // Freshness is unbounded: the newest event overall, not the window's.
    expect(w.lastEventAt).toBe(db.get(`SELECT MAX(timestamp) AS t FROM requestStats`).t);
  });
});

describe('usageHistory backfill (fresh table path)', () => {
  it('backfills once from usageHistory when requestStats is empty, extracting cache splits from the tokens JSON', async () => {
    // The module memoizes backfillStarted, so exercise a fresh module instance
    // against a cleared table.
    db.run(`DELETE FROM requestStats`);
    db.run(`DELETE FROM _meta WHERE key = 'statsBackfilled'`);
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, status, promptTokens, completionTokens, tokens)
       VALUES(?, 'prov-h', 'model-h', 'conn-h', 'success', 40, 4, ?)`,
      [
        iso(60),
        JSON.stringify({
          cache_read_input_tokens: 12,
          cache_creation_input_tokens: 3,
          reasoning_tokens: 2,
        }),
      ]
    );
    const fresh = await import('../../src/lib/db/repos/requestStatsRepo.js?backfill=1');
    const s = await fresh.getStatsSummary({ provider: 'prov-h' });
    expect(s.totalRequests).toBe(1);
    expect(s.cacheReadTokens).toBe(12); // via the cache_read_input_tokens alias
    expect(s.cacheCreationTokens).toBe(3);
    expect(s.inputTokens).toBe(25); // 40 - 12 - 3
    // Backfilled rows never measured latency, so none is claimed.
    expect(s.latency.avgLatencyMs).toBeNull();
    // The marker prevents a re-run even after the table empties again.
    expect(db.get(`SELECT value FROM _meta WHERE key = 'statsBackfilled'`).value).toBe('1');
  });
});
