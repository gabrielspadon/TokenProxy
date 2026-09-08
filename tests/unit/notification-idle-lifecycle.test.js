import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/repos/usageRepo.js', () => ({ statsEmitter: new EventEmitter() }));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({ getProviderConnections: async () => [], isConnectionDegraded: () => false }));
vi.mock('@/lib/db/repos/requestStatsRepo.js', () => ({ getTrafficWindow: async () => null }));
vi.mock('@/lib/notifications/webhooks.js', () => ({ emit() {}, getNotificationsConfig: async () => ({ enabled: false }) }));
vi.mock('@/lib/shutdown.js', () => ({ registerShutdownFlusher: () => () => {} }));
vi.mock('@/lib/notifications/delivery.js', () => ({ drainNotifications: async () => ({ processed: 0 }) }));
vi.mock('@/lib/notifications/remediationQueue.js', () => ({ drainAuthorizedActions: async () => ({ processed: 0 }) }));

const { ensureWatcher, stopWatcher } = await import('@/lib/notifications/watcher.js');
let state;
let emitter;
let rules;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  emitter = new EventEmitter();
  state = { subscribed: false, lastRunAt: 0, running: false, degraded: new Map(), errorRateFiring: false, lastRuleRunAt: 0, ruleRunning: false, startedAt: new Date().toISOString() };
  rules = vi.fn(async () => ({ evaluated: 1, fired: 0, events: [] }));
});
afterEach(async () => {
  if (typeof stopWatcher === 'function') await stopWatcher({ state, emitter });
  vi.useRealTimers();
});

describe('notification background ownership', () => {
  it('evaluates at startup and while completely idle without duplicate subscriptions', async () => {
    expect(ensureWatcher({ state, emitter, rules })).toBe(true);
    expect(ensureWatcher({ state, emitter, rules })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(rules).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount('update')).toBe(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(rules).toHaveBeenCalledTimes(2);
  });

  it('stops timer and listener, and aborts outstanding evaluation before shutdown', async () => {
    let signal;
    rules.mockImplementation(({ signal: caller }) => {
      signal = caller;
      return new Promise((resolve) => caller.addEventListener('abort', () => resolve({ evaluated: 0, fired: 0, events: [] }), { once: true }));
    });
    ensureWatcher({ state, emitter, rules });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal).toBeInstanceOf(AbortSignal);
    await stopWatcher({ state, emitter });
    expect(signal.aborted).toBe(true);
    expect(emitter.listenerCount('update')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(rules).toHaveBeenCalledTimes(1);
  });

  it('uses the same throttle for a timer tick and traffic at the same instant', async () => {
    ensureWatcher({ state, emitter, rules });
    emitter.emit('update');
    await vi.advanceTimersByTimeAsync(0);
    expect(rules).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    emitter.emit('update');
    await vi.advanceTimersByTimeAsync(0);
    expect(rules).toHaveBeenCalledTimes(2);
  });
});
