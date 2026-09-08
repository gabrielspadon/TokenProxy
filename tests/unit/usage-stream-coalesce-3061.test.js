// #3061 — "Opening the web dashboard causes a busy loop that takes down the
// entire server, including the /v1 gateway", and the polling half of #3029.
//
// The dashboard's usage stream subscribes to the process-wide statsEmitter,
// which fires as often as every 150ms while the gateway is serving traffic. Its
// "update" handler runs a FULL getUsageStats — the whole usageDaily rollup, two
// usageHistory scans, and a re-read of every provider connection and API key.
//
// Nothing stopped that handler re-entering. Whenever one recalculation outlived
// the interval that scheduled the next, they stacked: an unbounded set of
// in-flight recalcs on the very event loop that also serves /v1, which is why a
// single dashboard visit could take the gateway down with it. The emitter's
// other consumer (onStatsUpdate in lib/notifications/watcher.js) has always
// refused to re-enter; this asserts the stream route does the same, and that
// the coalescing still delivers a run for the last event it skipped.
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/analytics/refreshPolicy.js', () => ({ analyticsRefreshPolicy: () => ({ mode: 'normal', reason: 'fixture', streamIntervalMs: 250, refreshAfterMs: 15000 }) }));

const statsEmitter = new EventEmitter();
statsEmitter.setMaxListeners(50);

const calls = { stats: 0, active: 0 };
let concurrent = 0;
let peakConcurrent = 0;
let statsDelayMs = 0;

vi.mock('@/lib/usageDb', () => ({
  statsEmitter,
  getUsageStats: async () => {
    calls.stats += 1;
    concurrent += 1;
    peakConcurrent = Math.max(peakConcurrent, concurrent);
    if (statsDelayMs) await new Promise((r) => setTimeout(r, statsDelayMs));
    else await Promise.resolve();
    concurrent -= 1;
    return { totalRequests: calls.stats, recentRequests: [] };
  },
  getActiveRequests: async () => {
    calls.active += 1;
    return { activeRequests: [], recentRequests: [], errorProvider: '' };
  },
}));

const { GET } = await import('@/app/api/usage/stream/route.js');

function makeRequest(period = 'today') {
  const controller = new AbortController();
  return {
    controller,
    request: {
      url: `http://localhost:20128/api/usage/stream?period=${period}`,
      signal: controller.signal,
    },
  };
}

// start() subscribes only after its first awaited send resolves.
async function waitForSubscription() {
  for (let i = 0; i < 200; i++) {
    if (statsEmitter.listenerCount('update') > 0 && calls.stats > 0 && concurrent === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('stream never subscribed to statsEmitter');
}

const settle = async (ms = 60) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  statsEmitter.removeAllListeners();
  calls.stats = 0;
  calls.active = 0;
  concurrent = 0;
  peakConcurrent = 0;
  statsDelayMs = 0;
});

describe('the usage stream never stacks stats recalculations (#3061, #3029)', () => {
  it('keeps at most one getUsageStats in flight under a burst of updates', async () => {
    statsDelayMs = 30;
    const { request, controller } = makeRequest();
    await GET(request);
    await waitForSubscription();

    const baseline = calls.stats; // the initial send
    for (let i = 0; i < 25; i++) statsEmitter.emit('update');
    await settle(300);

    expect(peakConcurrent).toBe(1);
    // 25 events collapse to the one running recalc plus a single trailing run.
    expect(calls.stats - baseline).toBeLessThanOrEqual(2);
    controller.abort();
  });

  it('still runs once more for whatever arrived while it was busy', async () => {
    statsDelayMs = 40;
    const { request, controller } = makeRequest();
    await GET(request);
    await waitForSubscription();

    const baseline = calls.stats;
    statsEmitter.emit('update'); // runs
    await settle(270); // the shared cadence has started the first recalc
    statsEmitter.emit('update'); // invalidates while that read is running
    await settle(400);

    expect(calls.stats - baseline).toBe(2);
    controller.abort();
  });

  it('coalesces the lightweight pending handler on the same terms', async () => {
    const { request, controller } = makeRequest();
    await GET(request);
    await waitForSubscription();

    const baseline = calls.active;
    for (let i = 0; i < 20; i++) statsEmitter.emit('pending');
    await settle(150);

    // Without the guard each emit adds a getActiveRequests read of its own.
    expect(calls.active - baseline).toBeLessThan(20);
    controller.abort();
  });

  it('unsubscribes both handlers when the client disconnects', async () => {
    const { request, controller } = makeRequest();
    await GET(request);
    await waitForSubscription();
    expect(statsEmitter.listenerCount('update')).toBe(1);
    expect(statsEmitter.listenerCount('pending')).toBe(1);

    controller.abort();
    await settle(20);

    expect(statsEmitter.listenerCount('update')).toBe(0);
    expect(statsEmitter.listenerCount('pending')).toBe(0);
  });

  it('does not recalculate at all once the stream is closed', async () => {
    const { request, controller } = makeRequest();
    await GET(request);
    await waitForSubscription();
    controller.abort();
    await settle(20);

    const baseline = calls.stats;
    for (let i = 0; i < 10; i++) statsEmitter.emit('update');
    await settle(60);

    expect(calls.stats).toBe(baseline);
  });
});
