/**
 * #1323 — GET /api/providers/client?sort=priority returned 500.
 *
 * A 500 from this route is always the handler's own catch (route.js:142-145):
 * it swallows the cause and answers `{error: "Failed to fetch providers"}`, so
 * the report cannot say WHICH statement threw. Two candidates sit on the
 * `sort=priority` path, and both are settled by reading rather than by the
 * reporter's machine:
 *
 *   1. the comparator — `sortConnections` at route.js:88-93 already coerces
 *      both keys (`a.priority ?? Number.MAX_SAFE_INTEGER`, `(a.provider || "")`),
 *      so a null, absent or mistyped field cannot throw there. The sibling
 *      `sort=provider` branch at route.js:84 does NOT coerce, which is what
 *      makes the priority branch look suspicious by association.
 *   2. the row shape — `rowToConn` (src/lib/db/repos/connectionsRepo.js:16-27)
 *      builds every connection from named columns, and `provider` is
 *      `TEXT NOT NULL` while `priority` is a nullable INTEGER. So the exact
 *      inputs the comparator is accused of choking on are the ones it handles.
 *
 * These cases pin that down: the route answers 200 for the shapes a comparator
 * would throw on. Anything still 500-ing on this endpoint is upstream of the
 * sort, in `backfillAccountIdentity()` or `getProviderConnections()`, and those
 * live outside this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE_SUPPORTED_PROVIDERS } from '@/shared/constants/providers';

/** Rows the mocked DB returns; each test rewrites this. */
let rows = [];

vi.mock('@/lib/localDb', () => ({
  getProviderConnections: async () => rows,
}));

vi.mock('@/lib/oauth/providers', () => ({
  backfillAccountIdentity: async () => {},
}));

const conn = (over = {}) => ({
  id: 'c1',
  provider: 'claude',
  authType: 'oauth',
  isActive: true,
  ...over,
});

async function get(query) {
  const { GET } = await import('@/app/api/providers/client/route.js');
  const response = await GET(new Request(`http://localhost/api/providers/client?${query}`));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  rows = [];
});

describe('#1323 sort=priority survives the rows the DB can actually produce', () => {
  it('sorts when every row carries a priority', async () => {
    rows = [
      conn({ id: 'b', priority: 2 }),
      conn({ id: 'a', priority: 1 }),
      conn({ id: 'c', priority: 3 }),
    ];
    const { status, body } = await get('page=1&pageSize=20&accountStatus=all&sort=priority');
    expect(status).toBe(200);
    expect(body.connections.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it("does not throw when priority is null — the nullable column's own value", async () => {
    rows = [conn({ id: 'a', priority: null }), conn({ id: 'b', priority: 1 })];
    const { status, body } = await get('sort=priority');
    expect(status).toBe(200);
    // null sorts last, not first: `?? Number.MAX_SAFE_INTEGER`, not `|| 0`.
    expect(body.connections.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('does not throw when priority is absent entirely', async () => {
    rows = [conn({ id: 'a' }), conn({ id: 'b' })];
    const { status } = await get('sort=priority');
    expect(status).toBe(200);
  });

  it('does not throw when every priority ties and the provider key decides', async () => {
    // Both ids must survive isUsageEligible (route.js:65-69), so take them from
    // the same constant the route filters on rather than naming providers here.
    const [first, second] = [...USAGE_SUPPORTED_PROVIDERS].sort((a, b) => a.localeCompare(b));
    rows = [
      conn({ id: 'z', provider: second, priority: 1 }),
      conn({ id: 'a', provider: first, priority: 1 }),
    ];
    const { status, body } = await get('sort=priority');
    expect(status).toBe(200);
    expect(body.connections.map((c) => c.provider)).toEqual([first, second]);
  });

  it('does not throw on an empty connection list', async () => {
    const { status, body } = await get('sort=priority');
    expect(status).toBe(200);
    expect(body.connections).toEqual([]);
    expect(body.pagination.totalPages).toBe(1);
  });

  it('clamps a page past the end instead of answering a negative offset', async () => {
    rows = [conn({ id: 'a', priority: 1 })];
    const { status, body } = await get('page=99&pageSize=20&sort=priority');
    expect(status).toBe(200);
    expect(body.pagination.page).toBe(1);
    expect(body.connections).toHaveLength(1);
  });

  it('caps pageSize so one request cannot ask for the whole table', async () => {
    rows = Array.from({ length: 30 }, (_, i) => conn({ id: `c${i}`, priority: i }));
    const { body } = await get('pageSize=100000&sort=priority');
    expect(body.pagination.pageSize).toBe(500);
  });

  it('still answers 200 when the request omits sort (priority is the default)', async () => {
    rows = [conn({ id: 'b', priority: 2 }), conn({ id: 'a', priority: 1 })];
    const { status, body } = await get('page=1&pageSize=20&accountStatus=all');
    expect(status).toBe(200);
    expect(body.connections.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('a throw upstream of the sort is what a 500 on this route means', async () => {
    // Anchors the diagnosis to a real 500 rather than to reading alone: when the
    // connection load fails, the catch answers the reported body and the sort is
    // never reached, so the reported response says nothing about the comparator.
    rows = null; // .filter on null throws at route.js:108, before sortConnections
    const { status, body } = await get('sort=priority');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to fetch providers' });
  });
});
