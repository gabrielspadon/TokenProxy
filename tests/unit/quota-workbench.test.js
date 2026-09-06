import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { initDb } from '@/lib/db/index.js';
import { captureQuotaUsage } from '@/lib/db/repos/quotaHistoryRepo.js';
import { getQuotaWorkbench } from '@/lib/db/repos/quotaWorkbenchRepo.js';
import {
  parseQuotaWorkbenchQuery,
  readQuotaWorkbench,
  validateQuotaWorkbenchQuery,
} from '@/lib/db/analytics/quotaWorkbenchQueries.mjs';
import { openAnalyticsReadOnly } from '@/lib/db/analytics/readOnly.mjs';
import { DATA_FILE } from '@/lib/db/paths.js';
import * as analyticsClient from '@/lib/db/analytics/client.js';

vi.mock('@/dashboardGuard', () => ({
  hasValidCliToken: vi.fn(async (r) => r.headers.get('x-operator') === 'yes'),
  isLocalRequest: () => true,
}));
vi.mock('@/lib/auth/dashboardSession', () => ({
  verifyDashboardAuthToken: vi.fn(async () => false),
}));
vi.mock('@/lib/auth/clientApiKey', () => ({
  resolveClientApiKey: vi.fn(async (r) => ({ valid: r.headers.has('x-inference') })),
}));
import { GET } from '@/app/api/admin/quota/workbench/route.js';

const start = '2026-09-06T10:00:00.000Z',
  end = '2026-09-06T10:22:00.000Z';
const params = (extra = {}) =>
  new URLSearchParams({ connectionId: 'account-1', start, end, ...extra });
const conn = { id: 'account-1', provider: 'claude', accessToken: 'DO-NOT-EXPORT' };
let db;
beforeAll(async () => {
  await initDb();
  db = await getAdapter();
});
beforeEach(() => db.run('DELETE FROM quotaObservations'));
afterAll(async () => {
  await globalThis._contextAnalytics?.client.close();
});
async function seed({
  count = 5,
  connection = conn,
  scope = 'weekly',
  unit = 'requests',
  resourceType = 'request-limit',
} = {}) {
  for (let i = 0; i < count; i++) {
    const observedAt = new Date(Date.parse(start) + i * 300_000).toISOString();
    await captureQuotaUsage(
      connection,
      {
        quotaObservation: { id: `${connection.id}-${scope}-${unit}-${i}`, observedAt },
        quotas: {
          [scope]: {
            remaining: 100 - i * 10,
            remainingPercentage: 100 - i * 10,
            total: 100,
            unit,
            resourceType,
            resetAt: '2026-09-07T00:00:00Z',
          },
        },
      },
      { capturedAt: observedAt }
    );
  }
}

describe('quota workbench query boundary', () => {
  it('keeps all-retained scope explicit and rejects missing, duplicate or unsupported dimensions', () => {
    expect(
      parseQuotaWorkbenchQuery(new URLSearchParams({ connectionId: 'account-1' }), {
        now: Date.parse(end),
      })
    ).toEqual({
      start: '1970-01-01T00:00:00.000Z',
      end,
      filters: { connectionId: 'account-1' },
    });
    for (const query of [
      '',
      'connectionId=',
      'connectionId=a&model=foo',
      'connectionId=a&connectionId=b',
      'connectionId=a&start=2026-02-30T00:00:00Z',
      'connectionId=a&file=/private',
    ]) {
      expect(() => parseQuotaWorkbenchQuery(new URLSearchParams(query))).toThrow();
    }
    const valid = { operation: 'quota-workbench', ...parseQuotaWorkbenchQuery(params()) };
    expect(validateQuotaWorkbenchQuery(valid)).toEqual(valid);
    expect(() =>
      validateQuotaWorkbenchQuery({
        ...valid,
        filters: { ...valid.filters, sql: 'SELECT * FROM apiKeys' },
      })
    ).toThrow();
    expect(() => validateQuotaWorkbenchQuery({ ...valid, file: '/private' })).toThrow();
  });
  it('filters before population counting, preserves exclusive time and separates units/resources', async () => {
    await seed();
    await seed({ connection: { ...conn, id: 'account-2' } });
    await seed({ unit: 'USD', resourceType: 'monetary-budget' });
    await seed({ scope: 'hourly', unit: null });
    const result = await getQuotaWorkbench(params());
    expect(result).toMatchObject({
      total: 15,
      complete: true,
      modelAttribution: 'unavailable',
      mode: 'passive',
      timeRange: { field: 'capturedAt', start, end, endExclusive: true },
      freshness: { source: 'committed-sqlite' },
    });
    expect(result.series).toHaveLength(3);
    expect(result.series.map((series) => series.analysis.unit).sort()).toEqual([
      'USD',
      'percentage points',
      'requests',
    ]);
    expect(result.series.every((series) => series.analysis.segmentSampleCount === 5)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('DO-NOT-EXPORT');
    expect((await getQuotaWorkbench(params({ provider: 'other' }))).total).toBe(0);
    expect((await getQuotaWorkbench(params({ connectionId: "' OR 1=1 --" }))).total).toBe(0);
    expect((await getQuotaWorkbench(params({ end: '2026-09-06T10:20:00.000Z' }))).total).toBe(12);
  });
  it('uses reported percentage evidence when the named quota unit has no absolute balance', async () => {
    for (let i = 0; i < 5; i++) {
      const observedAt = new Date(Date.parse(start) + i * 300_000).toISOString();
      await captureQuotaUsage(
        conn,
        {
          quotaObservation: { id: `percent-only-${i}`, observedAt },
          quotas: {
            weekly: {
              unit: 'requests',
              remainingPercentage: 90 - i * 5,
              resetAt: '2026-09-07T00:00:00Z',
            },
          },
        },
        { capturedAt: observedAt }
      );
    }
    const result = await getQuotaWorkbench(params());
    expect(result.series).toHaveLength(1);
    expect(result.series[0]).toMatchObject({
      measurement: 'percentage',
      unit: 'requests',
      coverage: { records: 5, measured: 5 },
      analysis: {
        state: 'available',
        unit: 'percentage points',
        rate: { median: 60, unit: 'percentage points/hour' },
      },
    });
    expect(result.series[0].points.map((point) => point.value)).toEqual([90, 85, 80, 75, 70]);
    await seed();
    const mixed = await getQuotaWorkbench(params());
    expect(mixed.series).toHaveLength(2);
    expect(mixed.series.map((series) => series.analysis.unit).sort()).toEqual([
      'percentage points',
      'requests',
    ]);
  });
  it('reads beyond a first history page before computing the trend', async () => {
    db.transaction(() => {
      for (let i = 0; i < 250; i++)
        db.run(
          `INSERT INTO quotaObservations
        (id,connectionId,scope,source,observationKind,unit,remaining,"limit",observedAt,capturedAt,confidence)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            String(i),
            conn.id,
            'daily',
            'provider-usage',
            'observed',
            'requests',
            1000 - i,
            1000,
            new Date(Date.parse(start) + i * 4000).toISOString(),
            start,
            'reported',
          ]
        );
    });
    const result = await getQuotaWorkbench(params({ end: '2026-09-06T10:17:00.000Z' }));
    expect(result.series[0].analysis.segmentSampleCount).toBe(250);
    expect(result.series[0].points).toHaveLength(250);
    expect(result.series[0].analysis.rate.median).toBe(900);
  });
  it('refuses incomplete populations without scanning or forecasting the first 5000', () => {
    const fake = { get: vi.fn(() => ({ total: 5001 })), all: vi.fn() };
    expect(readQuotaWorkbench(fake, parseQuotaWorkbenchQuery(params()))).toMatchObject({
      complete: false,
      reason: 'observation_limit',
      total: 5001,
      series: [],
    });
    expect(fake.all).not.toHaveBeenCalled();
  });
  it('keeps the historical scan in the worker and supports committed native and persisted sql.js snapshots', async () => {
    await seed();
    const spy = vi.spyOn(db, 'all').mockImplementation(() => {
      throw new Error('Request-thread scan');
    });
    try {
      expect((await getQuotaWorkbench(params())).total).toBe(5);
    } finally {
      spy.mockRestore();
    }
    db.checkpoint?.();
    const native = await openAnalyticsReadOnly(DATA_FILE, db.driver),
      fallback = await openAnalyticsReadOnly(DATA_FILE, 'sql.js');
    try {
      const query = parseQuotaWorkbenchQuery(params());
      expect(readQuotaWorkbench(fallback, query)).toEqual(readQuotaWorkbench(native, query));
      expect(fallback.source).toBe('last-persisted-snapshot');
      expect(fallback.persistedAt).toEqual(expect.any(String));
    } finally {
      native.close();
      fallback.close();
    }
  });
  it('requires operator authorization and returns no-store evidence or sanitized busy failures', async () => {
    const request = (headers = { 'x-operator': 'yes' }) =>
      new Request(`http://localhost/api/admin/quota/workbench?${params()}`, { headers });
    expect((await GET(request({}))).status).toBe(401);
    expect((await GET(request({ 'x-inference': 'yes' }))).status).toBe(403);
    await seed();
    const good = await GET(request());
    expect(good.status).toBe(200);
    expect(good.headers.get('cache-control')).toBe('no-store');
    expect((await good.json()).series).toHaveLength(1);
    const spy = vi
      .spyOn(analyticsClient, 'readContextAnalytics')
      .mockRejectedValue(new analyticsClient.ContextAnalyticsError('DO-NOT-EXPORT'));
    try {
      const failed = await GET(request());
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain('DO-NOT-EXPORT');
    } finally {
      spy.mockRestore();
    }
  });
  it('passes the caller signal to the bounded analytics system', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getQuotaWorkbench(params(), { signal: controller.signal })).rejects.toBeInstanceOf(
      analyticsClient.ContextAnalyticsError
    );
  });
});
