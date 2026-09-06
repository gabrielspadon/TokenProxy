import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import {
  recordOperationStarted,
  recordOperationTerminal,
  sanitizeOperationDetails,
  getOperationEvents,
} from '@/lib/db/repos/operationEventsRepo.js';
import { parseOperationEventsQuery } from '@/lib/db/analytics/operationEventsQueries.mjs';
import { createProxyPool, getProxyPoolById } from '@/lib/db/repos/proxyPoolsRepo.js';
import { poolTestVerdict } from '@/shared/poolTestVerdict.js';

const mocks = vi.hoisted(() => ({ testProxyUrl: vi.fn(), testRelayUrl: vi.fn() }));

vi.mock('next/server', () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  },
}));
vi.mock('@/lib/network/proxyTest', () => ({
  testProxyUrl: mocks.testProxyUrl,
  testRelayUrl: mocks.testRelayUrl,
}));

const { POST: testProxyPool } = await import('../../src/app/api/proxy-pools/[id]/test/route.js');

let db;
beforeEach(async () => {
  db = await getAdapter();
  db.run('DELETE FROM operationEvents');
  db.run('DELETE FROM proxyPools');
});
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await globalThis._contextAnalytics?.client.close();
});

const base = {
  operationId: 'op-1',
  phase: 'reachability',
  source: 'proxy-pool-test',
  actorClass: 'operator',
  subjectKind: 'proxyPool',
  subjectId: 'p1',
};

describe('operation event invariants', () => {
  it('refuses a second started and a second terminal for the same operation/phase', async () => {
    await recordOperationStarted(base);
    await expect(recordOperationStarted(base)).rejects.toThrow();
    await recordOperationTerminal(base, { state: 'failed', code: 'probe_failed' });
    await expect(recordOperationTerminal(base, { state: 'succeeded' })).rejects.toThrow();
    // A started event in a DIFFERENT phase of the same operation is fine.
    await recordOperationStarted({ ...base, phase: 'authentication' });
  });

  it('an interrupted operation stays unresolved: started row only, no success', async () => {
    await recordOperationStarted(base);
    const rows = db.all('SELECT state FROM operationEvents WHERE operationId = ?', ['op-1']);
    expect(rows).toEqual([{ state: 'started' }]);
  });

  it('allowlists structural details and drops credentials, URLs and free text', () => {
    const details = JSON.parse(
      sanitizeOperationDetails({
        status: 502,
        elapsedMs: 120,
        cancelled: false,
        reason: 'connect refused',
        proxyUrl: 'http://user:hunter2@10.0.0.5:8080',
        targetHost: 'http://user:hunter2@evil/', // URL-shaped even in an allowed key
        stack: 'Error: at Object.<anonymous>',
        body: '{"secret":"sk-live-123"}',
      })
    );
    expect(details).toEqual({
      status: 502,
      elapsedMs: 120,
      cancelled: false,
      reason: 'connect refused',
    });
    expect(JSON.stringify(details)).not.toMatch(/hunter2|sk-live|proxyUrl|stack/);
  });

  it('rejects unknown, duplicate and oversized query parameters', () => {
    expect(() => parseOperationEventsQuery(new URLSearchParams('sql=DROP'))).toThrow();
    expect(() => parseOperationEventsQuery(new URLSearchParams('phase=a&phase=b'))).toThrow();
    expect(() => parseOperationEventsQuery(new URLSearchParams({ pageSize: '9999' }))).toThrow();
    expect(() => parseOperationEventsQuery(new URLSearchParams({ start: '2026-01-01' }))).toThrow();
  });
});

describe('proxy-pool test producer', () => {
  const request = (id, signal) =>
    new Request(`http://localhost/api/proxy-pools/${id}/test`, { method: 'POST', signal });
  const invoke = (id, signal) =>
    testProxyPool(request(id, signal), { params: Promise.resolve({ id }) });

  it("forwards the caller's cancellation signal into the probe", async () => {
    const pool = await createProxyPool({
      id: 'p1',
      name: 'p',
      proxyUrl: 'http://127.0.0.1:9',
      type: 'http',
    });
    const controller = new AbortController();
    mocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 499,
      cancelled: true,
      error: 'Proxy test cancelled',
    });
    await invoke(pool.id, controller.signal);
    // Request re-wraps the caller signal, so assert propagation, not identity:
    // aborting the caller's controller must abort the signal the probe received.
    const forwarded = mocks.testProxyUrl.mock.calls[0][0].signal;
    expect(forwarded).toBeInstanceOf(AbortSignal);
    expect(forwarded.aborted).toBe(false);
    controller.abort();
    expect(forwarded.aborted).toBe(true);
  });

  it('a cancelled probe records cancelled and does NOT bench the pool', async () => {
    const pool = await createProxyPool({
      id: 'p1',
      name: 'p',
      proxyUrl: 'http://127.0.0.1:9',
      type: 'http',
      isActive: true,
      testStatus: 'active',
    });
    mocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 499,
      cancelled: true,
      error: 'Proxy test cancelled',
    });
    const res = await invoke(pool.id);
    expect((await res.json()).outcome).toBe('cancelled');
    const after = await getProxyPoolById('p1');
    expect(after.isActive).toBe(true);
    expect(after.testStatus).toBe('active');
    const terminal = db.get("SELECT state, code FROM operationEvents WHERE state != 'started'");
    expect(terminal).toMatchObject({ state: 'cancelled', code: 'probe_cancelled' });
  });

  it('a late result against a changed pool records conflict and leaves the pool alone', async () => {
    const pool = await createProxyPool({
      id: 'p1',
      name: 'p',
      proxyUrl: 'http://old:1',
      type: 'http',
      isActive: true,
      testStatus: 'active',
    });
    mocks.testProxyUrl.mockImplementation(async () => {
      // Operator edits the pool while the probe is in flight.
      db.run('UPDATE proxyPools SET data = ? WHERE id = ?', [
        JSON.stringify({ name: 'p', proxyUrl: 'http://new:2', type: 'http' }),
        'p1',
      ]);
      return { ok: true, status: 200, elapsedMs: 5 };
    });
    const res = await invoke(pool.id);
    expect((await res.json()).outcome).toBe('conflict');
    const after = await getProxyPoolById('p1');
    expect(after.proxyUrl).toBe('http://new:2');
    expect(after.testStatus).toBe('active'); // late success applied nothing
    const terminal = db.get(
      "SELECT state, code, details FROM operationEvents WHERE state != 'started'"
    );
    expect(terminal).toMatchObject({ state: 'conflict', code: 'pool_configuration_changed' });
    expect(JSON.parse(terminal.details).conflict).toBe(true);
  });

  it('commits the terminal receipt atomically with the activation effect', async () => {
    const pool = await createProxyPool({
      id: 'p1',
      name: 'p',
      proxyUrl: 'http://127.0.0.1:9',
      type: 'http',
      isActive: true,
    });
    mocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 500,
      timedOut: true,
      error: 'Proxy test timed out',
    });
    const res = await invoke(pool.id);
    expect((await res.json()).outcome).toBe('failed');
    const after = await getProxyPoolById('p1');
    expect(after.isActive).toBe(false);
    expect(after.testStatus).toBe('error');
    expect(after.lastError).toBe('Proxy test timed out');
    const terminal = db.get("SELECT state, code FROM operationEvents WHERE state != 'started'");
    expect(terminal).toMatchObject({ state: 'failed', code: 'probe_timeout' });
  });

  it('dashboard verdict treats a 200 transport with ok:false body as unreachable', () => {
    const refusal = vi.fn();
    expect(poolTestVerdict({ ok: true, body: { ok: true } }, refusal).title).toBe('Reachable.');
    const failed = poolTestVerdict(
      { ok: true, body: { ok: false, status: 502, error: 'bad gateway' } },
      refusal
    );
    expect(failed.title).toBe('Unreachable.');
    expect(failed.tone).toBe('error');
    expect(refusal).not.toHaveBeenCalled();
  });
});

describe('operation history through the analytics worker', () => {
  it('applies filters before stable pagination', async () => {
    for (let i = 0; i < 7; i++) {
      await recordOperationStarted({ ...base, operationId: `op-${i}`, subjectId: 'pool-a' });
    }
    await recordOperationStarted({ ...base, operationId: 'op-other', subjectId: 'pool-b' });
    db.flush?.();
    // Explicit end in the future: rows captured in the same millisecond as a
    // defaulted `end` would be excluded by the endExclusive bound.
    const range = { end: new Date(Date.now() + 60_000).toISOString() };
    const page1 = await getOperationEvents(
      new URLSearchParams({ subjectId: 'pool-a', pageSize: '3', page: '1', ...range })
    );
    expect(page1).toMatchObject({ total: 7, pages: 3, hasMore: true });
    expect(page1.items).toHaveLength(3);
    expect(page1.items.every((row) => row.subjectId === 'pool-a')).toBe(true);
    const page3 = await getOperationEvents(
      new URLSearchParams({ subjectId: 'pool-a', pageSize: '3', page: '3', ...range })
    );
    expect(page3.items).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    const ids = [...page1.items, ...page3.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
