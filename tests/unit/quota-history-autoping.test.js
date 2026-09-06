import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('open-sse/index.js', () => ({}));
vi.mock('@/lib/localDb', () => ({ getSettings: vi.fn(), getProviderConnections: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock('@/app/api/usage/[connectionId]/route.js', () => ({ refreshAndUpdateCredentials: vi.fn() }));
import { initDb } from '@/lib/db/index.js';
import { getAdapter } from '@/lib/db/driver.js';
import { retainQuotaUsage, recordQuotaCheckEvent, getQuotaHistory } from '@/lib/db/repos/quotaHistoryRepo.js';
import { runQuotaAutoPingTick } from '@/shared/services/quotaAutoPing.js';
import { QUOTA_AUTOPING_CONFIG as C } from '@/shared/constants/config.js';

let db, deps, state, conn;
const start = '2026-09-06T00:00:00.000Z', end = '2026-09-07T00:00:00.000Z';
const time = '2026-09-06T12:00:00.000Z';
const future = '2026-09-06T18:00:00.000Z';
const rows = async kind => (await getQuotaHistory(new URLSearchParams({ kind, start, end }))).items;
const observedUsage = (quotas, observedAt = new Date().toISOString()) => ({ quotas, quotaObservation: { id: observedAt, observedAt, source: 'provider-usage' } });
beforeAll(async () => { await initDb(); db = await getAdapter(); });
beforeEach(() => {
  db.run('DELETE FROM quotaObservations'); db.run('DELETE FROM quotaCheckEvents');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(time));
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  conn = { id: 'codex-history', provider: 'codex', authType: 'oauth', accessToken: 'PRIVATE', providerSpecificData: {} };
  state = { running: false, failureCache: {}, resetCache: {}, seenResets: {}, allRunning: {} };
  deps = {
    getSettings: async () => ({ codexAutoPing: { connections: { [conn.id]: true } } }),
    getProviderConnections: async () => [conn],
    resolveConnectionProxyConfig: async () => ({}),
    refreshAndUpdateCredentials: async c => ({ connection: c }),
    updateProviderConnection: vi.fn(async (_id, patch) => Object.assign(conn, patch)),
    getUsageForProvider: vi.fn(async () => observedUsage({ session: { used: 1, remainingPercentage: 99, resetAt: future } })),
    getExecutor: () => ({ execute: vi.fn(async () => ({ response: new Response('', { status: 200 }) })) }),
    retainQuotaUsage, recordQuotaCheckEvent,
  };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('scheduler to persisted quota history', () => {
  it('records actual reads, a not-before reset check and skips held ticks without manufacturing events', async () => {
    await runQuotaAutoPingTick(deps, state);
    const events = await rows('checks');
    expect(events.map(e => e.eventType).sort()).toEqual(['completed', 'scheduled', 'started', 'usage-read']);
    expect(events.find(e => e.eventType === 'scheduled')).toMatchObject({ scheduledFor: new Date(Date.parse(future) - C.refreshAheadMs).toISOString(), resetAt: future, code: 'reset-not-before' });
    expect((await rows('observations'))[0]).toMatchObject({ percentage: 99, observedAt: time });
    await runQuotaAutoPingTick(deps, state);
    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
    expect(await rows('checks')).toHaveLength(4);
  });
  it('distinguishes actual HTTP response and scheduler bookkeeping from later running-clock confirmation', async () => {
    deps.getUsageForProvider.mockResolvedValueOnce(observedUsage({}));
    await runQuotaAutoPingTick(deps, state);
    expect((await rows('checks')).filter(e => e.eventType === 'warm-recorded')).toHaveLength(1);
    expect((await rows('checks')).find(e => e.eventType === 'warm-response')).toMatchObject({ code: 'http_200' });
    expect((await rows('checks')).some(e => e.eventType === 'clock-running')).toBe(false);
    vi.setSystemTime(new Date(Date.parse(time) + 120_000));
    await runQuotaAutoPingTick(deps, state);
    const events = await rows('checks');
    expect(events.find(e => e.eventType === 'clock-running')).toMatchObject({ scope: 'session', code: 'verified', observedAt: new Date().toISOString() });
    expect(new Set(events.filter(e => e.eventType === 'started').map(e => e.checkId)).size).toBe(2);
  });
  it('does not label a cached pre-warm observation as confirmation', async () => {
    conn.autoPingWindows = { session: { lastWarmedAt: time } };
    deps.getUsageForProvider.mockResolvedValue(observedUsage({ session: { used: 1, resetAt: future } }, '2026-09-06T11:00:00.000Z'));
    await runQuotaAutoPingTick(deps, state);
    expect((await rows('checks')).some(e => e.eventType === 'clock-running' || e.eventType === 'still-cold')).toBe(false);
    expect((await rows('checks')).find(e => e.eventType === 'usage-read').observedAt).toBe('2026-09-06T11:00:00.000Z');
  });
  it('retains a rejected HTTP response without converting legacy bookkeeping into acceptance', async () => {
    const provider = 'synthetic-history';
    C.providers[provider] = { settingsKey: 'syntheticHistory', quotaKey: 'session', expectedWindows: ['session'], authTypes: ['oauth'], pingModel: 'synthetic-model' };
    conn.provider = provider;
    deps.getSettings = async () => ({ syntheticHistory: { connections: { [conn.id]: true } } });
    deps.getUsageForProvider.mockResolvedValue(observedUsage({}));
    deps.getExecutor = () => ({ execute: async () => ({ response: new Response('', { status: 403 }) }) });
    try {
      await runQuotaAutoPingTick(deps, state);
      const events = await rows('checks');
      expect(events.find(e => e.eventType === 'warm-response').code).toBe('http_403');
      expect(events.find(e => e.eventType === 'warm-recorded').code).toBe('scheduler-recorded');
      expect(events.some(e => e.eventType === 'clock-running' || e.eventType === 'warm-accepted')).toBe(false);
    } finally { delete C.providers[provider]; }
  });
  it.each(['refresh', 'usage', 'warm'])('records %s exceptions without persisting provider error text', async stage => {
    if (stage === 'refresh') deps.refreshAndUpdateCredentials = async () => { throw new Error('PRIVATE'); };
    if (stage === 'usage') deps.getUsageForProvider.mockRejectedValue(new Error('PRIVATE'));
    if (stage === 'warm') { deps.getUsageForProvider.mockResolvedValue(observedUsage({})); deps.getExecutor = () => ({ execute: async () => { throw new Error('PRIVATE'); } }); }
    await runQuotaAutoPingTick(deps, state);
    const events = await rows('checks');
    expect(events.some(e => e.eventType === 'failed')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
    expect(events.some(e => e.eventType === 'warm-recorded')).toBe(false);
    expect(state.failureCache['codex:codex-history']).toBeDefined();
  });
  it('retention failure does not add attempts or prevent existing warm bookkeeping', async () => {
    deps.getUsageForProvider.mockResolvedValue(observedUsage({}));
    deps.recordQuotaCheckEvent = vi.fn(async () => { throw new Error('PRIVATE'); });
    deps.retainQuotaUsage = vi.fn(async () => { throw new Error('PRIVATE'); });
    await runQuotaAutoPingTick(deps, state);
    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
    expect(conn.lastPingAt).toBe(time);
    expect(console.warn).toHaveBeenCalledWith('[QuotaHistory] observation_write_failed');
    expect(await rows('checks')).toHaveLength(0);
  });
});
