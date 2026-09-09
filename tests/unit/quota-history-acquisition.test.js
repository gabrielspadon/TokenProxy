import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('open-sse/index.js', () => ({}));
vi.mock('open-sse/services/usage/claude.js', () => ({ getClaudeUsage: vi.fn() }));
vi.mock('@/lib/localDb', () => ({ getDailyConnectionUsage: vi.fn(), getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn(async (id, data) => ({ ...conn, ...data })) }));
vi.mock('open-sse/executors/index.js', () => ({ getExecutor: vi.fn() }));
vi.mock('@/lib/network/connectionProxy', () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
import { initDb } from '@/lib/db/index.js';
import { getAdapter } from '@/lib/db/driver.js';
import { getQuotaHistory } from '@/lib/db/repos/quotaHistoryRepo.js';
import { getClaudeUsage } from 'open-sse/services/usage/claude.js';
import { getUsageForProvider } from 'open-sse/services/usage.js';
import { getProviderConnectionById, updateProviderConnection } from '@/lib/localDb';
import { getExecutor } from 'open-sse/executors/index.js';
import { GET } from '@/app/api/usage/[connectionId]/route.js';
import { evaluateQuota, _clearQuotaCache } from '@/sse/services/quotaGuard.js';
const conn = { id: 'history-acquisition', provider: 'claude', authType: 'oauth', accessToken: 'PRIVATE', refreshToken: 'PRIVATE', providerSpecificData: {} };
const raw = () => ({ quotas: { weekly: { remainingPercentage: 70, total: 100, remaining: 70 } } });
const records = () => getQuotaHistory(new URLSearchParams({ start: '2020-01-01T00:00:00Z', end: '2099-01-01T00:00:00Z' }));
const request = () => GET(new Request(`http://localhost/api/usage/${conn.id}`), { params: Promise.resolve({ connectionId: conn.id }) });
let db;
beforeAll(async () => { await initDb(); db = await getAdapter(); });
beforeEach(() => {
  db.run('DELETE FROM quotaObservations'); _clearQuotaCache(); vi.clearAllMocks();
  getProviderConnectionById.mockResolvedValue(conn);
  getExecutor.mockReturnValue({ needsRefresh: () => false, refreshCredentials: vi.fn(async () => ({ accessToken: 'UPDATED-PRIVATE' })) });
});

describe('usage acquisition provenance', () => {
  it('the real dispatcher preserves cache identity and distinguishes fresh unchanged responses', async () => {
    const cached = raw(); getClaudeUsage.mockResolvedValueOnce(cached).mockResolvedValueOnce(cached).mockResolvedValueOnce(raw());
    const a = await getUsageForProvider(conn), b = await getUsageForProvider(conn), c = await getUsageForProvider(conn);
    expect(a.quotaObservation).toEqual(b.quotaObservation); expect(c.quotaObservation.id).not.toBe(a.quotaObservation.id);
    expect(c.quotaObservation).not.toHaveProperty('accessToken');
  });
  it('dashboard and routing reads retain the same sample once, and a later provider response adds one', async () => {
    const cached = raw(); getClaudeUsage.mockResolvedValue(cached);
    expect((await request()).status).toBe(200);
    const evaluated = await evaluateQuota(conn);
    expect(evaluated.snapshot.windows[0].remainingPercentage).toBe(70);
    expect((await records()).total).toBe(1);
    getClaudeUsage.mockResolvedValue(raw());
    expect((await request()).status).toBe(200);
    expect((await records()).total).toBe(2);
  });
  it('records the successful auth retry and persists its snapshot instead of the initial rejection', async () => {
    getClaudeUsage.mockResolvedValueOnce({ message: 'authentication expired', expired: true }).mockResolvedValueOnce(raw());
    const response = await request(); expect(response.status).toBe(200);
    expect(getClaudeUsage).toHaveBeenCalledTimes(2);
    expect((await records()).total).toBe(1);
    const snapshotWrite = updateProviderConnection.mock.calls.find(([, fields]) => fields.lastQuotaSnapshot);
    expect(snapshotWrite[1].lastQuotaSnapshot.windows[0].remainingPercentage).toBe(70);
    expect(snapshotWrite[1].lastQuotaSnapshot.fetchedAt).toBe((await records()).items[0].observedAt);
  });
  it('history failure preserves successful usage and never retries the provider', async () => {
    getClaudeUsage.mockResolvedValue(raw());
    const original = db.run.bind(db); const spy = vi.spyOn(db, 'run').mockImplementation((sql, values) => {
      if (sql.includes('quotaObservations')) throw new Error('PRIVATE'); return original(sql, values);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await request(); expect(response.status).toBe(200); expect(getClaudeUsage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[QuotaHistory] observation_write_failed');
    warn.mockRestore(); spy.mockRestore();
  });
});
