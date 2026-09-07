import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/db/driver.js', () => ({ getAdapter: async () => ({ all: () => [] }) }));
vi.mock('../../src/lib/db/repos/connectionsRepo.js', () => ({
  getProviderConnections: async () => [{ id: 'a', name: 'Account A' }, { id: 'b', name: 'Account B' }],
}));

let trackPendingRequest;
let getActiveRequests;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  vi.resetModules();
  global._pendingRequests = { byModel: {}, byAccount: {} };
  global._pendingTimers = {};
  global._statsEmitTimers = { pending: null, update: null };
  global._recentRing = { items: [], initialized: true };
  global._activeSessions = new Map();
  global._connectionMapCache = { map: {}, ts: 0 };
  ({ trackPendingRequest, getActiveRequests } = await import('../../src/lib/db/repos/usageRepo.js'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function count(account, model = 'm') {
  const { activeRequests } = await getActiveRequests();
  return activeRequests.find((row) => row.account === account && row.model === model)?.count ?? 0;
}

describe('pending request timeout ownership', () => {
  it('expires a remaining overlap after its sibling stops', async () => {
    trackPendingRequest('m', 'p', 'a', true);
    trackPendingRequest('m', 'p', 'a', true);
    await vi.advanceTimersByTimeAsync(10_000);
    trackPendingRequest('m', 'p', 'a', false);
    expect(await count('Account A')).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await count('Account A')).toBe(0);
    expect(global._pendingRequests.byModel).toEqual({});
    expect(global._pendingRequests.byAccount).toEqual({});
  });

  it('does not extend an older request deadline when a new request starts', async () => {
    trackPendingRequest('m', 'p', 'a', true);
    await vi.advanceTimersByTimeAsync(30_000);
    trackPendingRequest('m', 'p', 'a', true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await count('Account A')).toBe(1);
    expect(global._pendingRequests.byModel['m (p)']).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await count('Account A')).toBe(0);
  });

  it('expires only the contributing account while preserving another model and account', async () => {
    trackPendingRequest('m', 'p', 'a', true);
    await vi.advanceTimersByTimeAsync(30_000);
    trackPendingRequest('m', 'p', 'b', true);
    trackPendingRequest('other', 'p', 'a', true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await count('Account A')).toBe(0);
    expect(await count('Account B')).toBe(1);
    expect(await count('Account A', 'other')).toBe(1);
    expect(global._pendingRequests.byModel).toEqual({ 'm (p)': 1, 'other (p)': 1 });
    trackPendingRequest('m', 'p', 'b', false);
    trackPendingRequest('other', 'p', 'a', false);
    expect(global._pendingRequests.byAccount).toEqual({});
  });

  it('does not let an unmatched account stop decrement another account', async () => {
    trackPendingRequest('m', 'p', 'a', true);
    trackPendingRequest('m', 'p', 'b', false, true);
    expect(await count('Account A')).toBe(1);
    expect(global._pendingRequests.byModel['m (p)']).toBe(1);
    trackPendingRequest('m', 'p', 'a', false);
    trackPendingRequest('m', 'p', 'a', false);
    expect(global._pendingRequests.byModel).toEqual({});
  });

  it('keeps no-account requests in the model total until their own stop or expiry', async () => {
    trackPendingRequest('m', 'p', null, true);
    trackPendingRequest('m', 'p', null, true);
    trackPendingRequest('m', 'p', 'a', true);
    trackPendingRequest('m', 'p', null, false);
    expect(global._pendingRequests.byModel['m (p)']).toBe(2);
    trackPendingRequest('m', 'p', 'a', false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(global._pendingRequests.byModel).toEqual({});
    expect(global._pendingRequests.byAccount).toEqual({});
  });
});
