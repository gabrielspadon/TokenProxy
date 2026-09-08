import { describe, it, expect } from 'vitest';
import { createBoundedLogSink } from '../../open-sse/utils/boundedLogSink.js';

describe('bounded asynchronous diagnostics', () => {
  it('never invokes a sink on the producer stack and counts stalled in-flight bytes', async () => {
    let release;
    let calls = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const sink = createBoundedLogSink({ maxRecords: 3, maxBytes: 90, write: async () => { calls++; await pending; } });
    expect(sink.enqueue('redacted', 30)).toBe(true);
    expect(calls).toBe(0);
    await new Promise(setImmediate);
    expect(calls).toBe(1);
    for (let n = 0; n < 100000; n++) sink.enqueue('redacted', 30);
    expect(sink.status()).toMatchObject({ records: 3, bytes: 90, peakBytes: 90, dropped: 99998 });
    release();
    expect(await sink.flush()).toMatchObject({ drained: true, written: 3, records: 0, bytes: 0 });
  });
  it('bounded shutdown discards pending items while accurately reporting a hung write', async () => {
    let release;
    const sink = createBoundedLogSink({ write: () => new Promise(resolve => { release = resolve; }) });
    sink.enqueue('first', 5); sink.enqueue('second', 6);
    await new Promise(setImmediate);
    const start = performance.now();
    expect(await sink.close({ timeoutMs: 15 })).toMatchObject({ drained: false, records: 1, bytes: 5, dropped: 1 });
    expect(performance.now() - start).toBeLessThan(500);
    expect(sink.enqueue('late', 4)).toBe(false);
    release(); await sink.flush();
  });
  it('failed writes are counted without rejection or retry amplification', async () => {
    const sink = createBoundedLogSink({ write: async () => { throw new Error('controlled failure'); } });
    for (let n = 0; n < 100; n++) sink.enqueue('safe', 4);
    expect(await sink.flush()).toMatchObject({ failed: 100, records: 0, bytes: 0, drained: true });
  });
  it('cancellation discards pending records without double accounting', async () => {
    const sink = createBoundedLogSink({ write: async () => {} });
    sink.enqueue('safe', 4);
    expect(await sink.close({ discardPending: true })).toMatchObject({ dropped: 1, records: 0, bytes: 0 });
    expect(await sink.close()).toMatchObject({ dropped: 1, records: 0 });
  });
});

it('reserves completion evidence by evicting pending content without exceeding either cap', async () => {
  const seen = [];
  const sink = createBoundedLogSink({ maxRecords: 2, maxBytes: 10, write: async value => { seen.push(value); } });
  sink.enqueue('first', 5); sink.enqueue('body', 5);
  expect(sink.enqueue('receipt', 5, { evictPending: true })).toBe(true);
  expect(sink.status()).toMatchObject({ records: 2, bytes: 10, dropped: 1 });
  await sink.close();
  expect(seen).toEqual(['first', 'receipt']);
});

it('shares flush and close promises so a stalled sink cannot grow a waiter set', async () => {
  let release;
  const sink = createBoundedLogSink({ write: () => new Promise(resolve => { release = resolve; }) });
  sink.enqueue('safe', 4); await new Promise(setImmediate);
  const flush = sink.flush();
  for (let n = 0; n < 10000; n++) expect(sink.flush()).toBe(flush);
  const close = sink.close(); expect(sink.close()).toBe(close);
  release(); await close;
});

it('never evicts a queued session initializer to make room for completion evidence', async () => {
  const written = [];
  const sink = createBoundedLogSink({ maxRecords: 2, maxBytes: 10, write: async v => { written.push(v); } });
  sink.enqueue('begin', 5, { protected: true }); sink.enqueue('body', 5);
  sink.enqueue('receipt', 5, { evictPending: true, protected: true });
  await sink.close();
  expect(written).toEqual(['begin', 'receipt']);
});
