// Bounded local compatibility worker: one active + four queued, deadline kill,
// queued/running cancellation, retained-result byte cap, honest missing-edge
// refusal, and process-interrupt terminal states. Runs against the per-file
// isolated DATA_DIR sqlite; fake workers only — no threads, no network.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SAMPLE_FIXTURES } from '../../src/shared/compatibility/samples.js';

const originalDataDir = process.env.DATA_DIR;
let tempDir, store, createCompatibilityManager, LIMITS;

class FakeWorker extends EventEmitter {
  constructor(behavior) {
    super();
    this.terminated = false;
    if (behavior?.message !== undefined)
      queueMicrotask(() => this.emit('message', behavior.message));
    if (behavior?.error) queueMicrotask(() => this.emit('error', behavior.error));
  }
  terminate() {
    this.terminated = true;
    return Promise.resolve();
  }
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-compat-'));
  process.env.DATA_DIR = tempDir;
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  vi.resetModules();
  await (await import('@/lib/db/index.js')).initDb();
  const repo = await import('@/lib/db/repos/compatibilityRepo.js');
  store = await repo.getCompatibilityStore();
  ({ createCompatibilityManager } = await import('@/lib/compatibility/client.js'));
  ({ LIMITS } = await import('@/lib/compatibility/model.mjs'));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function fixture() {
  return store.createFixture(structuredClone(SAMPLE_FIXTURES[0]));
}
const terminal = (id, status) =>
  vi.waitFor(() => {
    expect(store.getRun(id).status).toBe(status);
  });

describe('bounded local worker', () => {
  it('admits one active plus four queued and refuses the sixth without scheduling', () => {
    const f = fixture();
    const spawned = [];
    const manager = createCompatibilityManager(store, {
      workerFactory: () => {
        const w = new FakeWorker();
        spawned.push(w);
        return w;
      },
    });
    const runs = Array.from({ length: 1 + LIMITS.queued }, () => manager.submit(f.id, f.revision));
    expect(spawned.length).toBe(1);
    expect(runs.map((run) => run.status)).toEqual([
      'running',
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
    expect(() => manager.submit(f.id, f.revision)).toThrow(/queue is full/);
    manager.close();
  });

  it('cancels a queued run before any worker starts and kills a running one at cancel', async () => {
    const f = fixture();
    const spawned = [];
    const manager = createCompatibilityManager(store, {
      workerFactory: () => {
        const w = new FakeWorker();
        spawned.push(w);
        return w;
      },
    });
    const running = manager.submit(f.id, f.revision);
    const queued = manager.submit(f.id, f.revision);
    expect(manager.cancel(queued.id).status).toBe('cancelled');
    expect(spawned.length).toBe(1);
    manager.cancel(running.id);
    await terminal(running.id, 'cancelled');
    expect(spawned[0].terminated).toBe(true);
    expect(store.getRun(running.id).error.code).toBe('operator_cancelled');
    manager.close();
  });

  it('kills a worker at the deadline with an explicit timed-out terminal state and pumps the queue', async () => {
    const f = fixture();
    const spawned = [];
    const manager = createCompatibilityManager(store, {
      timeoutMs: 30,
      workerFactory: () => {
        const w = new FakeWorker();
        spawned.push(w);
        return w;
      },
    });
    const first = manager.submit(f.id, f.revision);
    const second = manager.submit(f.id, f.revision);
    await terminal(first.id, 'timed-out');
    expect(spawned[0].terminated).toBe(true);
    expect(store.getRun(first.id).error.code).toBe('deadline');
    await vi.waitFor(() => {
      expect(store.getRun(second.id).status).toBe('running');
    });
    manager.close();
    await terminal(second.id, 'interrupted');
  });

  it('a result over the retained byte cap becomes a failed terminal receipt, not a stuck run', async () => {
    const f = fixture();
    const oversized = { checks: [], blob: 'x'.repeat(LIMITS.resultBytes) };
    const manager = createCompatibilityManager(store, {
      workerFactory: () => new FakeWorker({ message: { result: oversized } }),
    });
    const run = manager.submit(f.id, f.revision);
    await terminal(run.id, 'failed');
    const stored = store.getRun(run.id);
    expect(stored.error.code).toBe('result_unretainable');
    expect(stored.result).toBeNull();
    manager.close();
  });

  it('worker error and premature exit both land on failed, never silent', async () => {
    const f = fixture();
    const errored = createCompatibilityManager(store, {
      workerFactory: () => new FakeWorker({ error: new Error('boom') }),
    });
    const runA = errored.submit(f.id, f.revision);
    await terminal(runA.id, 'failed');
    expect(store.getRun(runA.id).error.code).toBe('worker_failed');
    errored.close();
    const exited = createCompatibilityManager(store, {
      workerFactory: () => {
        const w = new FakeWorker();
        queueMicrotask(() => w.emit('exit', 1));
        return w;
      },
    });
    const runB = exited.submit(f.id, f.revision);
    await terminal(runB.id, 'failed');
    expect(store.getRun(runB.id).error.code).toBe('worker_exited');
    exited.close();
  });

  it("a new process interrupts the previous owner's pending runs without replaying them", () => {
    const f = fixture();
    const first = createCompatibilityManager(store, { workerFactory: () => new FakeWorker() });
    const orphan = first.submit(f.id, f.revision);
    // Simulate a process end with no close(): the run is left running.
    const spawned = [];
    const second = createCompatibilityManager(store, {
      workerFactory: () => {
        const w = new FakeWorker();
        spawned.push(w);
        return w;
      },
    });
    expect(store.getRun(orphan.id).status).toBe('interrupted');
    expect(spawned.length).toBe(0);
    first.close();
    second.close();
  });
});

describe('honest missing-edge failure', () => {
  it('an unsupported route refuses execution instead of passing the payload through', async () => {
    vi.resetModules();
    vi.doMock('../../open-sse/translator/index.js', async (importOriginal) => ({
      ...(await importOriginal()),
      describeTranslationRoute: () => ({
        supported: false,
        kind: 'request',
        mode: 'unavailable',
        edges: [],
        missing: [{ from: 'openai', to: 'claude' }],
      }),
    }));
    const { executeLocalFixture } = await import('../../src/lib/compatibility/runner.mjs');
    expect(() => executeLocalFixture(structuredClone(SAMPLE_FIXTURES[0].definition))).toThrow(
      /No passthrough was substituted/
    );
    vi.doUnmock('../../open-sse/translator/index.js');
    vi.resetModules();
  });
});

describe('owner-scoped persistence', () => {
  it('refuses cross-owner reads and terminal transitions without any write', async () => {
    const { compatibilityStore } = await import('@/lib/db/repos/compatibilityRepo.js');
    const { getAdapter } = await import('@/lib/db/driver.js');
    const other = compatibilityStore(await getAdapter(), 'other-installation');
    const f = fixture();
    const { run } = store.createRun(f.id, f.revision, 'owner-test');
    expect(other.getFixture(f.id)).toBeNull();
    expect(other.getRun(run.id)).toBeNull();
    expect(() =>
      other.transition(run.id, 'failed', { error: { code: 'x', message: 'x' } })
    ).toThrow(/not found/);
    expect(store.getRun(run.id).status).toBe('queued');
    expect(() => other.createRun(f.id, f.revision, 'other')).toThrow(/not found/);
  });

  it('terminal states are immutable receipts', () => {
    const f = fixture();
    const { run } = store.createRun(f.id, f.revision, 'owner-test');
    store.transition(run.id, 'cancelled', { error: { code: 'operator_cancelled', message: 'x' } });
    const after = store.transition(run.id, 'failed', { error: { code: 'late', message: 'late' } });
    expect(after.status).toBe('cancelled');
    expect(store.getRun(run.id).error.code).toBe('operator_cancelled');
  });
});
