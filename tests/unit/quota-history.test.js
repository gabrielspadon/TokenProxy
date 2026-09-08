import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { initDb } from '@/lib/db/index.js';
import { captureQuotaUsage, retainQuotaUsage, quotaObservationsFromUsage, recordQuotaCheckEvent, getQuotaHistory, parseQuotaHistoryQuery } from '@/lib/db/repos/quotaHistoryRepo.js';
import { putWindows, getWindows } from '@/lib/db/repos/quotaWindowsRepo.js';
import { withQuotaObservation } from 'open-sse/services/usage/observation.js';
import { deriveQuotaSnapshot } from '@/shared/utils/quotaPause.js';
import { openAnalyticsReadOnly } from '@/lib/db/analytics/readOnly.mjs';
import { DATA_FILE } from '@/lib/db/paths.js';
import * as analyticsClient from '@/lib/db/analytics/client.js';
import { validateQuotaHistoryQuery } from '@/lib/db/analytics/quotaHistoryQueries.mjs';

// The actual operator policy and repository run. Only credential collectors
// are mocked; no usage provider or network function is reachable from this API.
vi.mock('@/dashboardGuard', () => ({ hasValidCliToken: vi.fn(async r => r.headers.get('x-operator') === 'yes'), isLocalRequest: () => true }));
vi.mock('@/lib/auth/dashboardSession', () => ({ verifyDashboardAuthToken: vi.fn(async () => false) }));
vi.mock('@/lib/auth/clientApiKey', () => ({ resolveClientApiKey: vi.fn(async r => ({ valid: r.headers.has('x-inference') })) }));
import { GET } from '@/app/api/admin/quota/history/route.js';
import { GET as quotaGET } from '@/app/api/admin/quota/route.js';

const conn = { id: 'account-1', provider: 'claude', accessToken: 'PRIVATE-CREDENTIAL' };
const capturedAt = '2026-09-06T12:00:00.000Z';
const observedAt = '2026-09-06T11:59:00.000Z';
const since = '2026-09-01T00:00:00.000Z';
const until = '2026-09-07T00:00:00.000Z';
const params = (extra = {}) => new URLSearchParams({ since, until, ...extra });
const usage = (extra = {}) => ({ quotaObservation: { id: 'sample-1', observedAt }, quotas: { weekly: { remaining: 20, total: 100, remainingPercentage: 20, resetAt: '2026-09-08T12:00:00Z', ...extra } }, privateBlob: 'PRIVATE-CREDENTIAL' });
let db;
beforeAll(async () => { await initDb(); db = await getAdapter(); });
beforeEach(() => { db.run('DELETE FROM quotaObservations'); db.run('DELETE FROM quotaCheckEvents'); });
afterAll(async () => { await globalThis._contextAnalytics?.client.close(); });

describe('retained quota observations', () => {
  it('makes samples and check outcomes visible to a separate persisted reader', async () => {
    await captureQuotaUsage(conn, usage(), { capturedAt });
    await recordQuotaCheckEvent({ connectionId: conn.id, checkId: 'persisted', eventType: 'failed', code: 'usage_exception', capturedAt });
    db.checkpoint?.();
    const reader = await openAnalyticsReadOnly(DATA_FILE, db.driver);
    try {
      expect(reader.get('SELECT COUNT(*) AS total FROM quotaObservations').total).toBe(1);
      expect(reader.get('SELECT code FROM quotaCheckEvents WHERE checkId = ?', ['persisted']).code).toBe('usage_exception');
    } finally { reader.close(); }
  });
  it('persists roundtrip without labeling a synthetic 100 scale as absolute units', async () => {
    expect(await captureQuotaUsage(conn, usage(), { capturedAt })).toBe(1);
    const page = await getQuotaHistory(params());
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ connectionId: conn.id, scope: 'weekly', remaining: null, limit: null, unit: null, resourceType: null, percentage: 20, observedAt, capturedAt, confidence: 'reported-percentage', source: 'provider-usage' });
    expect(JSON.stringify(page)).not.toContain('PRIVATE-CREDENTIAL');
  });
  it('preserves known zero balances, explicit units and independent resource scopes', async () => {
    const input = usage({ unit: 'requests', resourceType: 'request-limit', remaining: 0, windowDurationMs: 3_600_000, windowType: 'rolling' });
    input.quotas.wallet = { unit: 'USD', wallet: true, total: null, remaining: 0, remainingPercentage: null, resetAt: null };
    await captureQuotaUsage(conn, input, { capturedAt });
    const page = await getQuotaHistory(params());
    expect(page.items.find(r => r.scope === 'weekly')).toMatchObject({ remaining: 0, limit: 100, unit: 'requests', resourceType: 'request-limit', windowDurationMs: 3_600_000, windowType: 'rolling' });
    expect(page.items.find(r => r.scope === 'wallet')).toMatchObject({ remaining: 0, limit: null, percentage: null, resetAt: null, resourceType: 'monetary-budget', unit: 'USD' });
  });
  it('deduplicates reused snapshots, retains changed payloads at the same time and new unchanged observations', async () => {
    const a = usage();
    expect(await captureQuotaUsage(conn, a, { capturedAt })).toBe(1);
    expect(await captureQuotaUsage(conn, a, { capturedAt: until })).toBe(0);
    const b = usage(); b.quotaObservation = { id: 'sample-2', observedAt: '2026-09-06T12:00:00Z' };
    expect(await captureQuotaUsage(conn, b, { capturedAt })).toBe(1);
    expect(await captureQuotaUsage(conn, usage({ remainingPercentage: 19 }), { capturedAt })).toBe(1);
    expect((await getQuotaHistory(params())).total).toBe(3);
  });
  it('does not turn unknown time or invalid numbers into an epoch or measured zero', async () => {
    const input = usage({ unit: 'requests', remaining: null, total: '', remainingPercentage: Infinity, resetAt: '' });
    delete input.quotaObservation;
    const row = quotaObservationsFromUsage(conn, input, { capturedAt })[0];
    expect(row).toMatchObject({ observedAt: null, remaining: null, limit: null, percentage: null, resetAt: null, confidence: 'unknown' });
    await captureQuotaUsage(conn, input, { capturedAt });
    expect((await getQuotaHistory(params({ timeField: 'observedAt' }))).total).toBe(0);
    expect((await getQuotaHistory(params())).total).toBe(1);
  });
  it('keeps cached reader receipts stable and fresh unchanged reader receipts distinct', () => {
    const raw = { quotas: { weekly: { remainingPercentage: 20 } } };
    const a = withQuotaObservation(raw), b = withQuotaObservation(raw), c = withQuotaObservation(structuredClone(raw));
    expect(a.quotaObservation).toEqual(b.quotaObservation);
    expect(c.quotaObservation.id).not.toBe(a.quotaObservation.id);
    expect(raw).not.toHaveProperty('quotaObservation');
    expect(deriveQuotaSnapshot('claude', a).fetchedAt).toBe(a.quotaObservation.observedAt);
  });
  it('updates current freshness for unchanged values but does not append history during selection', async () => {
    const window = { scope: 'weekly', remaining: 20, limit: 100, observedAt, confidence: 'fresh' };
    await putWindows(conn.id, [window]);
    await putWindows(conn.id, [{ ...window, observedAt: capturedAt }]);
    expect((await getWindows(conn.id))[0].observedAt).toBe(capturedAt);
    const spy = vi.spyOn(db, 'run');
    await putWindows(conn.id, [{ ...window, observedAt: capturedAt }]);
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
    expect((await getQuotaHistory(params())).total).toBe(0);
  });
  it('rolls back a failed multi-window insert and leaves existing samples intact', async () => {
    await captureQuotaUsage(conn, usage(), { capturedAt });
    const input = usage(); input.quotaObservation.id = 'new'; input.quotas.next = { unit: 'requests', remaining: 3 };
    const original = db.run.bind(db);
    const spy = vi.spyOn(db, 'run').mockImplementation((sql, values) => { if (values?.[3] === 'next') throw new Error('PRIVATE-CREDENTIAL'); return original(sql, values); });
    await expect(captureQuotaUsage(conn, input, { capturedAt })).rejects.toThrow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await retainQuotaUsage(conn, input)).toBeNull();
    expect(warn).toHaveBeenCalledWith('[QuotaHistory] observation_write_failed');
    warn.mockRestore(); spy.mockRestore();
    expect((await getQuotaHistory(params())).total).toBe(1);
  });
});

describe('history queries and operator boundary', () => {
  it('advertises available history only after actual observations exist', async () => {
    const request = () => new Request('http://localhost/api/admin/quota', { headers: { 'x-operator': 'yes' } });
    const empty = await (await quotaGET(request())).json();
    expect(empty.historyAvailable).toBe(false);
    expect(empty.retainedHistory).toMatchObject({ observationCount: 0, checkEventCount: 0 });
    await captureQuotaUsage(conn, usage(), { capturedAt });
    const observed = await (await quotaGET(request())).json();
    expect(observed.historyAvailable).toBe(true);
    expect(observed.retainedHistory.observationCount).toBe(1);
    expect(observed.historyBackfilled).toBe(false);
  });
  it('filters before counting and paging, with stable ordering and explicit horizon', async () => {
    for (let i = 0; i < 5; i++) { const u = usage(); u.quotaObservation.id = String(i); await captureQuotaUsage({ ...conn, id: i === 4 ? 'other' : conn.id }, u, { capturedAt }); }
    const first = await getQuotaHistory(params({ connectionId: conn.id, pageSize: '2' }));
    const second = await getQuotaHistory(params({ connectionId: conn.id, pageSize: '2', page: '2' }));
    expect(first.total).toBe(4); expect(first.hasMore).toBe(true); expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map(r => r.id)).size).toBe(4);
    expect(first.timeRange).toEqual({ field: 'capturedAt', start: since, end: until, endExclusive: true, defaultHorizonDays: null });
    const defaults = parseQuotaHistoryQuery(new URLSearchParams(), { now: Date.parse(capturedAt) });
    expect(defaults.defaultHorizonDays).toBe(30); expect(defaults.start).toBe('2026-08-07T12:00:00.000Z');
    expect((await getQuotaHistory(params({ connectionId: "' OR 1=1 --" }))).total).toBe(0);
  });
  it('uses half-open UTC ranges with documented conflict-free time aliases', async () => {
    await captureQuotaUsage(conn, usage(), { capturedAt });
    expect((await getQuotaHistory(new URLSearchParams({ start: since, end: capturedAt }))).total).toBe(0);
    expect((await getQuotaHistory(new URLSearchParams({ start: capturedAt, end: until }))).total).toBe(1);
    expect((await getQuotaHistory(new URLSearchParams({ since: capturedAt, until }))).total).toBe(1);
    expect(() => parseQuotaHistoryQuery(new URLSearchParams({ start: '2026-09-06T12:00:00', end: until }))).toThrow();
    expect(() => parseQuotaHistoryQuery(new URLSearchParams({ start: '1', end: until }))).toThrow();
  });
  it.each([{ pageSize: '0' }, { pageSize: '201' }, { page: '-1' }, { page: '9007199254740992' }, { start: since, since }, { limit: '2' }, { since: '' }, { kind: 'quotaWindows' }, { timeField: '1=1' }, { since: until, until: since }])('rejects invalid query %j', async invalid => {
    const response = await GET(new Request(`http://localhost/api/admin/quota/history?${params(invalid)}`, { headers: { 'x-operator': 'yes' } }));
    expect(response.status).toBe(400);
  });
  it('rejects anonymous and inference credentials before the repository query', async () => {
    const spy = vi.spyOn(db, 'all');
    for (const [headers, status] of [[{}, 401], [{ 'x-inference': 'yes' }, 403]]) expect((await GET(new Request('http://localhost/api/admin/quota/history', { headers }))).status).toBe(status);
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  });
  it('returns authenticated persisted data and sanitized failure without refreshing a provider', async () => {
    await captureQuotaUsage(conn, usage(), { capturedAt });
    const request = () => new Request(`http://localhost/api/admin/quota/history?${params()}`, { headers: { 'x-operator': 'yes' } });
    const response = await GET(request()); expect(response.status).toBe(200); expect((await response.json()).total).toBe(1);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const spy = vi.spyOn(analyticsClient, 'readContextAnalytics').mockRejectedValue(new analyticsClient.ContextAnalyticsError('PRIVATE-CREDENTIAL'));
    const error = await GET(request()); expect(error.status).toBe(503); expect(await error.text()).not.toContain('PRIVATE-CREDENTIAL'); spy.mockRestore();
  });
  it('keeps current capacity readable when historical analytics are unavailable', async () => {
    const spy = vi.spyOn(analyticsClient, 'readContextAnalytics').mockRejectedValue(new analyticsClient.ContextAnalyticsError('busy'));
    try {
      const response = await quotaGET(new Request('http://localhost/api/admin/quota', { headers: { 'x-operator': 'yes' } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ historyAvailable: null, historyState: 'unavailable', retainedHistory: null });
    } finally { spy.mockRestore(); }
  });
  it('bounds optional history waiting and cancels abandoned reads', async () => {
    const spy = vi.spyOn(analyticsClient, 'readContextAnalytics').mockImplementation((query, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new analyticsClient.ContextAnalyticsError('cancelled')), { once: true });
    }));
    try {
      const started = performance.now();
      const response = await quotaGET(new Request('http://localhost/api/admin/quota', { headers: { 'x-operator': 'yes' } }));
      expect(response.status).toBe(200);
      expect((await response.json()).historyState).toBe('unavailable');
      expect(spy.mock.calls[0][1].signal.aborted).toBe(true);
      expect(performance.now() - started).toBeLessThan(1500);
    } finally { spy.mockRestore(); }
  });
  it('rejects ambiguous dimensions and worker SQL or path injection', () => {
    for (const raw of ['provider=claude&provider=codex', 'unknown=value', 'start=2026-02-30T10:00:00Z&end=2026-03-01T10:00:00Z']) {
      expect(() => parseQuotaHistoryQuery(new URLSearchParams(raw))).toThrow();
    }
    const query = { operation: 'quota-history', ...parseQuotaHistoryQuery(params()) };
    expect(validateQuotaHistoryQuery(query)).toEqual(query);
    for (const changed of [{ ...query, file: '/private' }, { ...query, filters: { sql: 'SELECT * FROM apiKeys' } }, { operation: 'quota-history-summary', sql: 'anything' }]) {
      expect(() => validateQuotaHistoryQuery(changed)).toThrow();
    }
  });
  it('reads history off-thread and reports its committed snapshot', async () => {
    await captureQuotaUsage(conn, usage(), { capturedAt });
    const spy = vi.spyOn(db, 'all').mockImplementation(() => { throw new Error('Request-thread historical scan'); });
    try {
      const page = await getQuotaHistory(params());
      expect(page.total).toBe(1);
      expect(page.freshness).toMatchObject({ source: 'committed-sqlite', persistedAt: null });
    } finally { spy.mockRestore(); }
  });
  it('retains scheduled and actual check events separately without raw errors', async () => {
    const event = { connectionId: conn.id, provider: conn.provider, checkId: 'check-1', eventType: 'scheduled', scheduledFor: until, resetAt: until, code: 'reset-not-before', capturedAt, rawError: 'PRIVATE-CREDENTIAL' };
    expect(await recordQuotaCheckEvent(event)).toBe(1);
    expect(await recordQuotaCheckEvent({ ...event, checkId: 'check-2' })).toBe(0);
    await recordQuotaCheckEvent({ ...event, eventType: 'started', code: null });
    await recordQuotaCheckEvent({ ...event, eventType: 'failed', code: 'usage_exception' });
    const page = await getQuotaHistory(params({ kind: 'checks', checkId: 'check-1' }));
    expect(page.total).toBe(3); expect(JSON.stringify(page)).not.toContain('PRIVATE-CREDENTIAL');
    expect((await getQuotaHistory(params({ kind: 'checks', eventType: 'failed' }))).total).toBe(1);
    await expect(recordQuotaCheckEvent({ ...event, code: 'PRIVATE-CREDENTIAL' })).rejects.toThrow('Invalid quota check code');
  });
  it('joins warming outcomes to the exact observed resource and filters before pagination', async () => {
    const sample = usage({ unit: 'requests', resourceType: 'request-limit' });
    await captureQuotaUsage(conn, sample, { capturedAt });
    const firstId = quotaObservationsFromUsage(conn, sample, { capturedAt })[0].id;
    const wallet = usage({ unit: 'USD', resourceType: 'monetary-budget' });
    await captureQuotaUsage(conn, wallet, { capturedAt });
    const secondId = quotaObservationsFromUsage(conn, wallet, { capturedAt })[0].id;
    const event = { connectionId: conn.id, provider: conn.provider, scope: 'weekly', eventType: 'warm-outcome', code: 'http_200', outcome: 'accepted', targetModel: 'fixture-model', capturedAt };
    for (const observationId of [firstId, firstId, secondId]) {
      await recordQuotaCheckEvent({ ...event, observationId, unit: 'forged', resourceType: 'forged' });
    }
    const first = await getQuotaHistory(params({ kind: 'checks', unit: 'requests', resourceType: 'request-limit', outcome: 'accepted', targetModel: 'fixture-model', pageSize: '1' }));
    const second = await getQuotaHistory(params({ kind: 'checks', observationId: firstId, pageSize: '1', page: '2' }));
    expect(first.total).toBe(2); expect(first.hasMore).toBe(true);
    expect(second.total).toBe(2); expect(second.hasMore).toBe(false);
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(first.items[0]).toMatchObject({ observationId: firstId, unit: 'requests', resourceType: 'request-limit' });
    expect((await getQuotaHistory(params({ kind: 'checks', unit: 'USD' }))).items[0].observationId).toBe(secondId);
    for (const mismatch of [{ connectionId: 'another-account' }, { scope: 'session' }, { provider: 'codex' }, { observationId: '0'.repeat(64) }]) {
      await expect(recordQuotaCheckEvent({ ...event, observationId: firstId, ...mismatch })).rejects.toThrow('Quota observation does not match check target');
    }
    await recordQuotaCheckEvent({ ...event, checkId: 'without-link' });
    expect((await getQuotaHistory(params({ kind: 'checks', checkId: 'without-link' }))).items[0]).toMatchObject({ observationId: null, resourceType: null, unit: null });
  });
});
