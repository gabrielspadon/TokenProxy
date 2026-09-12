// Installing a SIGINT/SIGTERM listener replaces Node's default terminate action.
// The centralized shutdown registry (src/lib/shutdown.js) owns the signal
// handlers and exits after all flushers run, so a DB adapter only has to
// register its flush — the signal still terminates the process afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerShutdownFlusher, runShutdownFlushers } from '../../src/lib/shutdown.js';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';

const SIGNALS = ['SIGINT', 'SIGTERM'];

let tempDir;
let adapter;
let baseline;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-sqljs-shutdown-'));
  baseline = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s).slice()]));
});

afterEach(async () => {
  try {
    adapter?.close();
  } catch {
    /* already closed */
  }
  adapter = undefined;
  // Drop whatever the registry installed so one test cannot affect the next.
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!baseline[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function makeAdapter() {
  adapter = await createSqlJsAdapter(path.join(tempDir, 'data.sqlite'));
  return adapter;
}

const added = (signal) => process.listeners(signal).filter((l) => !baseline[signal].includes(l));

describe('sql.js adapter shutdown', () => {
  it.each(SIGNALS)('%s is handled exactly once through the shutdown registry', async (signal) => {
    await makeAdapter();
    expect(added(signal)).toHaveLength(1);

    // Creating a second adapter must not stack another signal owner.
    const second = await createSqlJsAdapter(path.join(tempDir, 'second.sqlite'));
    try {
      second.close();
    } catch {
      /* best effort */
    }
    expect(added(signal)).toHaveLength(1);
  });

  it('flushes a pending write through the registry before exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      const db = await makeAdapter();
      const file = path.join(tempDir, 'data.sqlite');
      db.exec('CREATE TABLE t (v TEXT)');
      db.run('INSERT INTO t(v) VALUES(?)', ['kept']);
      expect(fs.existsSync(file)).toBe(false); // the save is debounced

      // The registry's SIGINT/SIGTERM handler is shutdownProcess(), which runs
      // exactly these flushers before exiting; simulated here in-process.
      await runShutdownFlushers();

      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBeGreaterThan(0);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('registerShutdownFlusher rejects non-functions', () => {
    expect(() => registerShutdownFlusher('nope')).toThrow(TypeError);
  });
});

describe('node:sqlite adapter process isolation', () => {
  it.runIf(Number(process.versions.node.split('.')[0]) >= 22)('does not replace the process-wide event emitter', async () => {
    const originalEmit = process.emit;
    const native = await createNodeSqliteAdapter(path.join(tempDir, 'native.sqlite'));
    try {
      expect(process.emit).toBe(originalEmit);
    } finally {
      native.close();
    }
    expect(process.emit).toBe(originalEmit);
  });
});
