import { describe, expect, it, vi } from 'vitest';
import { rankAccounts, normalizeAccountWindows } from '@/shared/utils/quotaRanking.js';
import { selectAndReserve } from '@/sse/services/accountScheduler.js';
import { decideRepin } from '@/shared/utils/repinPolicy.js';
import { createLeaseRegistry } from '@/shared/utils/accountLease.js';

const NOW = Date.parse('2026-09-06T12:00:00Z');
const HOUR = 3_600_000;
const win = (scope, hours, remaining = 50, extra = {}) => ({
  scope, resetAt: new Date(NOW + hours * HOUR).toISOString(), remaining,
  limit: 100, observedAt: new Date(NOW).toISOString(), confidence: 'fresh', ...extra,
});
const account = (id, windows = [win('weekly (7d)', 24)]) => ({ id, windows });
function fixture(capacity = 1) {
  const pins = new Map();
  const key = ({ sessionHash, model }) => `${sessionHash}/${model}`;
  const repos = {
    transaction: (fn) => fn(), getPin: (args) => pins.get(key(args)),
    setPin: vi.fn((args) => pins.set(key(args), { connectionId: args.connectionId, pinnedAt: args.at })),
    touchPin: vi.fn(), recordSwitch: vi.fn((r) => r),
    countActivePins: ({ model }) => Object.fromEntries(['a', 'b', 'c'].map((id) => [id,
      [...pins].filter(([k, p]) => k.endsWith(`/${model}`) && p.connectionId === id).length])),
  };
  const registry = createLeaseRegistry({ capacityOf: () => capacity });
  return { repos, registry, pins, select: (overrides = {}) => selectAndReserve({
    sessionHash: 'agent', model: 'claude-fable-5', accounts: [account('a'), account('b')],
    now: NOW, registry, repos, ...overrides,
  }) };
}

describe('cache and money routing invariants', () => {
  it('orders every tied quota horizon before any shorter one', () => {
    const a = account('a', [win('monthly (30d)', 400), win('weekly (7d)', 50), win('session (5h)', 1)]);
    const b = account('b', [win('monthly (30d)', 400), win('weekly (7d)', 24), win('session (5h)', 4)]);
    expect(rankAccounts([a, b], { now: NOW }).winner.id).toBe('b');
  });
  it('prioritizes earlier monthly reset despite lower load on a later account', () => {
    expect(rankAccounts([account('a', [win('monthly (30d)', 100)]), account('b', [win('monthly (30d)', 200)])], {
      now: NOW, activeLoad: { a: { pins: 4 } },
    }).winner.id).toBe('a');
  });
  it('waits for a healthy pin at capacity without writing a new pin', () => {
    const f = fixture();
    const first = f.select();
    expect(first.connection.id).toBe('a');
    expect(f.select()).toMatchObject({ unavailable: true, reason: 'at-capacity' });
    expect(f.repos.setPin).toHaveBeenCalledTimes(1);
    f.registry.release(first.lease);
    expect(f.select().connection.id).toBe('a');
  });
  it('spreads concurrent new agents with tied horizons and retains their pins', async () => {
    const f = fixture(2);
    const agents = ['one', 'two', 'three', 'four'];
    const first = await Promise.all(agents.map(async (sessionHash) => f.select({ sessionHash })));
    expect(first.map((r) => r.connection.id)).toEqual(['a', 'b', 'a', 'b']);
    first.forEach((r) => f.registry.release(r.lease));
    for (const [i, sessionHash] of agents.entries()) {
      const result = f.select({ sessionHash });
      expect(result.connection.id).toBe(first[i].connection.id);
      f.registry.release(result.lease);
    }
  });
  it.each(['setPin', 'recordSwitch'])('releases a reservation if %s fails', (method) => {
    const f = fixture();
    f.repos[method].mockImplementation(() => { throw new Error('disk full'); });
    expect(() => f.select()).toThrow('disk full');
    expect(f.registry.inFlight()).toBe(0);
  });
  it('releases a reservation if transaction commit fails', () => {
    const f = fixture();
    f.repos.transaction = (fn) => { fn(); throw new Error('commit failed'); };
    expect(() => f.select()).toThrow('commit failed');
    expect(f.registry.inFlight()).toBe(0);
  });
  it('does not coerce missing quota values into explicit zero entitlement', () => {
    const record = win('weekly (7d)', 24, null, { limit: null });
    expect(normalizeAccountWindows([record]).blocked).toBe(false);
    expect(rankAccounts([account('a', [record])], { now: NOW }).winner.id).toBe('a');
  });
  it('does not hold a pin whose explicit entitlement is zero', () => {
    expect(decideRepin({ pin: { connectionId: 'a' }, accounts: [account('a', [win('weekly (7d)', 24, 0, { limit: 0 })])], now: NOW }).action).toBe('none');
  });
  it('holds the pin when the entire pool has uncertain depleted snapshots', () => {
    const records = ['a', 'b'].map((id) => account(id, [win('weekly (7d)', 24, 0, { confidence: 'unknown' })]));
    expect(decideRepin({ pin: { connectionId: 'a' }, accounts: records, now: NOW })).toMatchObject({ action: 'keep', connectionId: 'a' });
  });
  it('waits until every exhausted window on at least one account has reset', () => {
    const f = fixture();
    const result = f.select({ accounts: [
      account('a', [win('monthly (30d)', 72, 0), win('session (5h)', 1, 0)]),
      account('b', [win('monthly (30d)', 100, 0), win('session (5h)', 4, 0)]),
    ] });
    expect(result).toMatchObject({ unavailable: true, earliestResetAt: new Date(NOW + 72 * HOUR).toISOString() });
  });
  it('applies scoped subquota exhaustion only to the requested model family', () => {
    const records = [account('a', [win('weekly (7d)', 24), win('weekly opus (7d)', 24, 0)]), account('b')];
    expect(rankAccounts(records, { now: NOW, model: 'claude-opus-5' }).winner.id).toBe('b');
    expect(rankAccounts(records, { now: NOW, model: 'claude-sonnet-5' }).winner.id).toBe('a');
  });
  it('honors account model eligibility when the previous pin is no longer entitled', () => {
    const f = fixture();
    f.registry.release(f.select().lease);
    const result = f.select({ accounts: [
      { ...account('a'), providerSpecificData: { enabledModels: ['claude-opus-5'] } },
      { ...account('b'), providerSpecificData: { enabledModels: ['claude-fable-5', 'claude-opus-5'] } },
    ] });
    expect(result.connection.id).toBe('b');
    expect(result.receipt.model).toBe('claude-fable-5');
  });
});
