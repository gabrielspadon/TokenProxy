import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let adapter, gate, release, writes, events, repositories, removeCloser;
vi.mock('@/lib/db/driver.js', () => ({ getAdapter: () => gate || Promise.resolve(adapter) }));
vi.mock('@/lib/db/repos/requestStatsRepo.js', () => ({ saveRequestStats: async () => {} }));
vi.mock('@/lib/db/repos/settingsRepo.js', () => ({ getSettings: async () => ({
  enableObservability: true, observabilityBatchSize: Number(process.env.OBSERVABILITY_BATCH_SIZE || 20),
}) }));

beforeEach(() => {
  vi.resetModules();
  writes = []; events = []; repositories = []; gate = null; release = null;
  vi.stubEnv('OBSERVABILITY_ENABLED', 'true');
  vi.stubEnv('OBSERVABILITY_BATCH_SIZE', '20');
  adapter = {
    transaction: callback => callback(),
    run: (sql, values) => { if (sql.startsWith('INSERT')) { writes.push(values[0]); events.push(`write:${values[0]}`); } },
    get: () => ({ c: writes.length }),
  };
  if (globalThis.__tokenproxyShutdownState) globalThis.__tokenproxyShutdownState.shutdownPromise = null;
});
afterEach(async () => {
  release?.(adapter);
  await Promise.all(repositories.map(repo => repo.__test__.dispose()));
  removeCloser?.(); removeCloser = null;
  if (globalThis.__tokenproxyShutdownState) globalThis.__tokenproxyShutdownState.shutdownPromise = null;
  vi.unstubAllEnvs();
});
async function loadRepository() {
  vi.resetModules();
  const repo = await import('@/lib/db/repos/requestDetailsRepo.js');
  repositories.push(repo);
  return repo;
}
const detail = id => ({ id, provider: 'fixture', model: 'fixture-model', status: 'success' });

it('flushes every module instance before adapter close without multiplying process listeners', async () => {
  const first = await loadRepository();
  const eventsToCount = ['SIGINT', 'SIGTERM', 'beforeExit', 'exit'];
  const counts = eventsToCount.map(name => process.listenerCount(name));
  await first.saveRequestDetail(detail('detail-0'));
  for (let index = 1; index < 12; index++) {
    const repo = await loadRepository();
    await repo.saveRequestDetail(detail(`detail-${index}`));
  }
  expect(eventsToCount.map(name => process.listenerCount(name))).toEqual(counts);
  expect(writes).toEqual([]);
  const { registerShutdownFlusher, runShutdownFlushers } = await import('@/lib/shutdown.js');
  removeCloser = registerShutdownFlusher(() => events.push('adapter-close'), 100);
  await runShutdownFlushers();
  expect(new Set(writes)).toEqual(new Set(Array.from({ length: 12 }, (_, index) => `detail-${index}`)));
  expect(events.at(-1)).toBe('adapter-close');
  expect(repositories.every(repo => repo.__test__.bufferSize() === 0)).toBe(true);
});

it('joins an in-flight flush and subsequent buffered work before allowing adapter close', async () => {
  vi.stubEnv('OBSERVABILITY_BATCH_SIZE', '1');
  gate = new Promise(resolve => { release = resolve; });
  const repo = await loadRepository();
  await repo.saveRequestDetail(detail('already-flushing'));
  await repo.saveRequestDetail(detail('queued-during-flush'));
  const { registerShutdownFlusher, runShutdownFlushers } = await import('@/lib/shutdown.js');
  removeCloser = registerShutdownFlusher(() => events.push('adapter-close'), 100);
  let shutdownFinished = false;
  const shutdown = runShutdownFlushers().then(() => { shutdownFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(events).toEqual([]);
  expect(shutdownFinished).toBe(false);
  release(adapter);
  await shutdown;
  expect(events).toEqual(['write:already-flushing', 'write:queued-during-flush', 'adapter-close']);
});

it('bounds shutdown of a stuck adapter and never writes after the adapter-close boundary', async () => {
  vi.stubEnv('OBSERVABILITY_BATCH_SIZE', '1');
  gate = new Promise(resolve => { release = resolve; });
  const repo = await loadRepository();
  await repo.saveRequestDetail({ ...detail('stalled'), request: { password: 'secret', content: 'x'.repeat(1000000) } });
  for (let n = 0; n < 100; n++) await repo.saveRequestDetail(detail(`queued-${n}`));
  expect(repo.__test__.bufferStatus().retainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  const result = await repo.__test__.shutdown();
  expect(result.drained).toBe(false);
  expect(repo.__test__.bufferSize()).toBe(0);
  release(adapter);
  await new Promise(setImmediate);
  expect(writes).toEqual([]);
  expect(repo.__test__.bufferStatus().retainedBytes).toBe(0);
});
