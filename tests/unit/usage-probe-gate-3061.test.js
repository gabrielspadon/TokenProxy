import { beforeEach, describe, expect, it } from 'vitest';
import {
  runUsageProbe,
  __resetUsageProbeGate,
  MAX_CONCURRENT_PROBES,
  MAX_WAITING_PROBES,
} from '@/lib/usageProbeGate.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => __resetUsageProbeGate());

// The dashboard fetches every connection's quota at once, and each fetch is a
// live provider call preceded by a token refresh. With thirty accounts nothing
// bounded the fan-out (#3061).
describe('live quota probes run under a ceiling (#3061)', () => {
  it('never runs more than the limit at once, however many are asked for', async () => {
    let running = 0,
      peak = 0;
    const gates = [];
    const probes = Array.from({ length: 30 }, () => {
      const d = deferred();
      gates.push(d);
      return () => {
        running++;
        peak = Math.max(peak, running);
        return d.promise.finally(() => running--);
      };
    });

    const all = probes.map((p, i) => runUsageProbe(`conn-${i}|cached`, p));
    await settle();
    expect(peak).toBe(MAX_CONCURRENT_PROBES);

    gates.forEach((g) => g.resolve('ok'));
    await Promise.all(all);
    expect(peak).toBe(MAX_CONCURRENT_PROBES);
  });

  it('drains the queue, so a bounded ceiling is not a dropped request', async () => {
    const seen = [];
    const all = Array.from({ length: 12 }, (_, i) =>
      runUsageProbe(`conn-${i}|cached`, async () => {
        seen.push(i);
        return i;
      })
    );
    expect(await Promise.all(all)).toEqual([...Array(12).keys()]);
    expect(seen).toHaveLength(12);
  });

  it('collapses concurrent callers that want the same thing onto one call', async () => {
    let calls = 0;
    const d = deferred();
    const probe = () => {
      calls++;
      return d.promise;
    };
    const a = runUsageProbe('same|cached', probe);
    const b = runUsageProbe('same|cached', probe);
    expect(a).toBe(b);
    d.resolve('shared');
    expect(await a).toBe('shared');
    expect(await b).toBe('shared');
    expect(calls).toBe(1);
  });

  it('a forced refresh is not served by an unforced probe already in flight', async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
      return calls;
    };
    await Promise.all([runUsageProbe('same|cached', probe), runUsageProbe('same|force', probe)]);
    expect(calls).toBe(2);
  });

  it('a failed probe releases its slot instead of wedging the gate shut', async () => {
    const failing = Array.from({ length: MAX_CONCURRENT_PROBES }, (_, i) =>
      runUsageProbe(`bad-${i}|cached`, async () => {
        throw new Error('upstream down');
      }).catch((e) => e.message)
    );
    expect(await Promise.all(failing)).toEqual(Array(MAX_CONCURRENT_PROBES).fill('upstream down'));
    expect(await runUsageProbe('good|cached', async () => 'alive')).toBe('alive');
  });

  it('a key is reusable once its probe has settled', async () => {
    let calls = 0;
    const probe = async () => ++calls;
    expect(await runUsageProbe('same|cached', probe)).toBe(1);
    expect(await runUsageProbe('same|cached', probe)).toBe(2);
  });

  it('the wait queue is bounded and overflow rejects with PROBE_QUEUE_FULL', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_PROBES }, () => deferred());
    const running = gates.map((g, i) => runUsageProbe(`run-${i}|cached`, () => g.promise));
    const queued = Array.from({ length: MAX_WAITING_PROBES }, (_, i) =>
      runUsageProbe(`wait-${i}|cached`, async () => i)
    );
    await settle();
    await expect(runUsageProbe('overflow|cached', async () => 'x')).rejects.toMatchObject({
      code: 'PROBE_QUEUE_FULL',
    });
    gates.forEach((g) => g.resolve());
    await Promise.all([...running, ...queued]);
  });

  it('aborting a QUEUED probe dequeues it without touching running probes', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_PROBES }, () => deferred());
    const running = gates.map((g, i) =>
      runUsageProbe(`run-${i}|cached`, async () => {
        await g.promise;
        return i;
      })
    );
    const ac = new AbortController();
    let queuedRan = false;
    const queued = runUsageProbe(
      'queued|cached',
      async () => {
        queuedRan = true;
      },
      ac.signal
    );
    await settle();
    ac.abort();
    await expect(queued).rejects.toBeTruthy();
    expect(queuedRan).toBe(false);
    gates.forEach((g) => g.resolve());
    expect(await Promise.all(running)).toEqual([0, 1, 2, 3]);
    // slot bookkeeping intact after the abort
    expect(await runUsageProbe('after|cached', async () => 'ok')).toBe('ok');
  });

  it('an aborted queued key is reusable immediately', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_PROBES }, () => deferred());
    const running = gates.map((g, i) => runUsageProbe(`run-${i}|cached`, () => g.promise));
    const ac = new AbortController();
    const queued = runUsageProbe('re|cached', async () => 'first', ac.signal);
    await settle();
    ac.abort();
    await expect(queued).rejects.toBeTruthy();
    gates.forEach((g) => g.resolve());
    await Promise.all(running);
    expect(await runUsageProbe('re|cached', async () => 'second')).toBe('second');
  });

  it('callers coalescing onto a still-queued probe share one upstream call', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_PROBES }, () => deferred());
    const running = gates.map((g, i) => runUsageProbe(`run-${i}|cached`, () => g.promise));
    let calls = 0;
    const a = runUsageProbe('join|cached', async () => ++calls);
    const b = runUsageProbe('join|cached', async () => ++calls);
    gates.forEach((g) => g.resolve());
    await Promise.all(running);
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(calls).toBe(1);
  });
});
