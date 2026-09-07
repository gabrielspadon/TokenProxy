/**
 * #1245 — memory grows without an upper bound over days of normal load.
 *
 * `saveRequestDetail` pushes whole request and response bodies onto a
 * module-level array and relies entirely on `flushToDatabase` draining it. That
 * drain is not guaranteed: `flushToDatabase` returns immediately while another
 * flush is in flight (requestDetailsRepo.js:123), so while one flush sits in an
 * `await` — a locked SQLite file, a slow disk, the `sql.js` fallback rewriting
 * the whole image — every further request keeps pushing and nothing evicts.
 * Each entry is capped at `maxJsonSize` on its own; the COUNT was uncapped.
 *
 * Dropping the oldest overflow is safe rather than lossy, and the two reasons
 * are what make this a fix and not a trade:
 *   - accounting is untouched. `saveRequestStats` runs before the push
 *     (requestDetailsRepo.js:183) and does not read this buffer.
 *   - the flush already deletes all but the newest `maxRecords` rows
 *     (requestDetailsRepo.js:162-167), so anything evicted here was going to be
 *     deleted there. The ceiling is held at or above `maxRecords` so the
 *     survivors are always a superset of what the write would have kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Held open so a flush can be stalled mid-`await` for the length of a test. */
let releaseAdapter;
let adapterGate;

vi.mock('@/lib/db/driver.js', () => ({
  getAdapter: () => adapterGate,
}));

vi.mock('@/lib/db/repos/requestStatsRepo.js', () => ({
  saveRequestStats: async () => {},
}));

vi.mock('@/lib/db/repos/settingsRepo.js', () => ({
  // Empty settings: the config resolver falls through to the env vars below.
  getSettings: async () => ({}),
}));

const detail = (i) => ({
  provider: 'claude',
  model: 'sonnet',
  status: 'success',
  // Large enough that an unbounded count is a memory problem, not a rounding one.
  request: { body: 'x'.repeat(1024) },
  response: { body: `${i}`.repeat(512) },
});

beforeEach(() => {
  vi.resetModules();
  adapterGate = new Promise((resolve) => {
    releaseAdapter = resolve;
  });
  process.env.OBSERVABILITY_ENABLED = 'true';
  process.env.OBSERVABILITY_BATCH_SIZE = '2';
  process.env.OBSERVABILITY_MAX_RECORDS = '5';
});

afterEach(async () => {
  releaseAdapter?.({ transaction: callback => callback(), run() {}, get: () => ({ c: 0 }) });
  const repo = await import('@/lib/db/repos/requestDetailsRepo.js');
  await repo.__test__.dispose();
  delete process.env.OBSERVABILITY_ENABLED;
  delete process.env.OBSERVABILITY_BATCH_SIZE;
  delete process.env.OBSERVABILITY_MAX_RECORDS;
});

describe('#1245 the observability write buffer is bounded', () => {
  it('stops growing once the flush stalls, instead of tracking request count', async () => {
    const repo = await import('@/lib/db/repos/requestDetailsRepo.js');

    // The first push past batchSize starts a flush that never finishes, because
    // getAdapter() never settles. Every later push lands in the buffer.
    for (let i = 0; i < 500; i += 1) await repo.saveRequestDetail(detail(i));

    // limit = max(maxRecords 5, batchSize 2 * 10) = 20.
    expect(repo.__test__.bufferSize()).toBeLessThanOrEqual(20);
    expect(repo.__test__.bufferSize()).toBeGreaterThan(0);
  });

  it("keeps the NEWEST entries, matching the retention sweep's own order", async () => {
    const repo = await import('@/lib/db/repos/requestDetailsRepo.js');
    for (let i = 0; i < 100; i += 1) await repo.saveRequestDetail({ ...detail(i), id: `d${i}` });
    // Nothing older than the ceiling survives; the tail is what the DB would keep.
    expect(repo.__test__.bufferSize()).toBe(20);
  });

  it('the ceiling never falls below maxRecords, so no kept row is evicted early', async () => {
    // A large configured retention must widen the buffer with it, or the cap
    // would start discarding rows the write side was going to keep.
    process.env.OBSERVABILITY_MAX_RECORDS = '300';
    vi.resetModules();
    const repo = await import('@/lib/db/repos/requestDetailsRepo.js');
    for (let i = 0; i < 500; i += 1) await repo.saveRequestDetail(detail(i));
    expect(repo.__test__.bufferSize()).toBe(300);
  });

  it('does not buffer at all while observability is off', async () => {
    process.env.OBSERVABILITY_ENABLED = 'false';
    vi.resetModules();
    const repo = await import('@/lib/db/repos/requestDetailsRepo.js');
    for (let i = 0; i < 50; i += 1) await repo.saveRequestDetail(detail(i));
    expect(repo.__test__.bufferSize()).toBe(0);
  });
});
