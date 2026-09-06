// Scheduler + status + failure-path coverage for freeModelSync.js:
// configureFreeModelSync / startFreeModelSync / stopFreeModelSync,
// getFreeModelSyncStatus, the fixture-base URL redirect, the top-level run
// failure, and the auto-combo error isolation. All fetch calls stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  settings: {},
  freeModels: {},
  combos: new Map(),
  comboUpdateError: null,
};

vi.mock('@/lib/localDb', () => ({
  getSettings: async () => {
    if (state.settings === 'THROW') throw new Error('db exploded');
    return state.settings;
  },
  getFreeModels: async () => JSON.parse(JSON.stringify(state.freeModels)),
  getFreeModelsForProvider: async (id) => state.freeModels[id] || null,
  setFreeModels: async (id, ids) => {
    state.freeModels[id] = { ids, updatedAt: new Date().toISOString() };
  },
  addCustomModel: async () => true,
  deleteCustomModel: async () => {},
  getComboById: async (id) => state.combos.get(id) || null,
  updateCombo: async (id, data) => {
    if (state.comboUpdateError) throw new Error(state.comboUpdateError);
    Object.assign(state.combos.get(id), data);
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  configureFreeModelSync,
  getFreeModelSyncStatus,
  getSyncTargets,
  runFreeModelSync,
  startFreeModelSync,
  stopFreeModelSync,
} from '@/shared/services/freeModelSync.js';

const emptyCatalog = { ok: true, status: 200, json: async () => ({ data: [] }) };

beforeEach(() => {
  vi.useFakeTimers();
  state.settings = {};
  state.freeModels = {};
  state.combos = new Map();
  state.comboUpdateError = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(emptyCatalog);
  delete process.env.FREE_MODEL_SYNC_FIXTURE_BASE;
});

afterEach(() => {
  stopFreeModelSync();
  vi.useRealTimers();
  delete process.env.FREE_MODEL_SYNC_FIXTURE_BASE;
});

async function flush() {
  // Let the fire-and-forget runFreeModelSync settle without advancing timers.
  for (let i = 0; i < 500; i++) await Promise.resolve();
}

describe('configureFreeModelSync scheduler', () => {
  it('does nothing when disabled', async () => {
    configureFreeModelSync({ freeModelSync: { enabled: false } });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs immediately and again on the configured cadence when enabled', async () => {
    configureFreeModelSync({ freeModelSync: { enabled: true, intervalHours: 4 } });
    await flush();
    const targets = getSyncTargets();
    expect(targets.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(targets.length);

    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(targets.length * 2);
  });

  it('startFreeModelSync reads the interval from settings; stop cancels the timer', async () => {
    state.settings = { freeModelSync: { enabled: true, intervalHours: 8 } };
    await startFreeModelSync();
    await flush();
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    stopFreeModelSync();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    stopFreeModelSync(); // idempotent when no timer is armed
  });
});

describe('FREE_MODEL_SYNC_FIXTURE_BASE redirect', () => {
  it('rewrites catalog origins to the fixture base, preserving paths', async () => {
    process.env.FREE_MODEL_SYNC_FIXTURE_BASE = 'http://127.0.0.1:21398';
    await runFreeModelSync();
    const targets = getSyncTargets();
    expect(fetchMock).toHaveBeenCalledTimes(targets.length);
    for (const [url] of fetchMock.mock.calls) {
      const u = new URL(url);
      expect(u.origin).toBe('http://127.0.0.1:21398');
    }
    // Paths come from each target's own modelsFetcher.url.
    const calledPaths = fetchMock.mock.calls.map(([url]) => new URL(url).pathname);
    const expectedPaths = targets.map((t) => new URL(t.modelsFetcher.url).pathname);
    expect(calledPaths.sort()).toEqual(expectedPaths.sort());
  });

  it('falls back to the original url when the base is unparseable', async () => {
    process.env.FREE_MODEL_SYNC_FIXTURE_BASE = '::not a url::';
    await runFreeModelSync();
    const targets = getSyncTargets();
    const calledOrigins = new Set(fetchMock.mock.calls.map(([url]) => new URL(url).origin));
    const expectedOrigins = new Set(targets.map((t) => new URL(t.modelsFetcher.url).origin));
    expect(calledOrigins).toEqual(expectedOrigins);
  });
});

describe('runFreeModelSync failure paths', () => {
  it('reports a top-level error when settings cannot be read', async () => {
    state.settings = 'THROW';
    const result = await runFreeModelSync();
    expect(result.error).toBe('db exploded');
    expect(result.skipped).toBe(false);
    // running flag was released in finally: a second run proceeds.
    state.settings = {};
    const again = await runFreeModelSync();
    expect(again.skipped).toBe(false);
  });

  it('records per-provider HTTP failures without stopping the pass', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const result = await runFreeModelSync();
    const targets = getSyncTargets();
    for (const t of targets) {
      expect(result.providers[t.id].error).toBe('HTTP 500');
    }
  });

  it('isolates an auto-combo update failure and skips deleted combos', async () => {
    state.combos.set('combo-live', { id: 'combo-live', models: [] });
    state.comboUpdateError = 'combo write failed';
    state.settings = {
      freeModelSync: {
        enabled: true,
        intervalHours: 4,
        autoComboIds: ['combo-live', 'combo-gone'],
      },
    };
    const result = await runFreeModelSync();
    // The pass still completes despite the combo failure.
    expect(result.error).toBeUndefined();
    expect(result.skipped).toBe(false);
  });
});

describe('getFreeModelSyncStatus', () => {
  it('reports config, targets and per-provider catalog state', async () => {
    const targets = getSyncTargets();
    const first = targets[0];
    state.settings = { freeModelSync: { enabled: true, intervalHours: 8, autoComboIds: [] } };
    state.freeModels = { [first.id]: { ids: ['m1', 'm2'], updatedAt: '2026-09-05T00:00:00Z' } };

    const status = await getFreeModelSyncStatus();
    expect(status.config).toEqual({ enabled: true, intervalHours: 8, autoComboIds: [] });
    expect(typeof status.running).toBe('boolean');
    expect(status.targets.map((t) => t.id)).toEqual(targets.map((t) => t.id));
    for (const t of status.targets) {
      expect(t).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          alias: expect.any(String),
          url: expect.any(String),
          type: expect.any(String),
        })
      );
    }
    expect(status.providers[first.id]).toEqual({
      ids: ['m1', 'm2'],
      count: 2,
      updatedAt: '2026-09-05T00:00:00Z',
    });
  });
});
