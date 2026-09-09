import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/admin/decisions — the one read surface over the decision-log NDJSON
// sink (docs/logging-design.md §3). Serves the same file decide.js appends,
// operator-gated via requireAdmin, filters (cls/verdict/rid/conn/since) AND
// together, newest-last capped by limit, and a torn or corrupt line is
// skipped rather than a 500.

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn() }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  },
}));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.requireAdmin }));

let tempDir;
let GET;
let decideMod;
const originalDataDir = process.env.DATA_DIR;

const call = (query = '') =>
  GET(new Request(`http://localhost/api/admin/decisions${query}`));

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-decisions-'));
  vi.resetModules();
  process.env.DATA_DIR = tempDir;
  decideMod = await import('@/shared/observability/decide.js');
  decideMod.__decide.resetState();
  ({ GET } = await import('@/app/api/admin/decisions/route.js'));
  mocks.requireAdmin.mockResolvedValue(null);
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const sink = () => path.join(tempDir, 'logs', 'decisions.ndjson');

function writeRecords(records) {
  fs.mkdirSync(path.dirname(sink()), { recursive: true });
  fs.writeFileSync(sink(), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('GET /api/admin/decisions', () => {
  it('refuses when requireAdmin refuses', async () => {
    mocks.requireAdmin.mockResolvedValue({ status: 401, body: { code: 'unauthorized' } });
    const res = await call();
    expect(res.status).toBe(401);
  });

  it('returns empty records when the sink does not exist yet', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ records: [], total: 0 });
  });

  it('serves what decide() wrote, through the same sink path', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    decideMod.decide('CRED', 'refresh-failed', { conn: 'abc12345', why: 'network' });
    await decideMod.__decide.flush();
    spy.mockRestore();
    const res = await call();
    expect(res.body.total).toBe(1);
    expect(res.body.records[0]).toMatchObject({ cls: 'CRED', verdict: 'refresh-failed', conn: 'abc12345' });
  });

  it('ANDs cls, verdict, rid and conn filters', async () => {
    writeRecords([
      { ts: '2026-09-06T01:00:00Z', cls: 'CRED', verdict: 'rotated', conn: 'aaaa1111', rid: '11112222' },
      { ts: '2026-09-06T01:01:00Z', cls: 'CRED', verdict: 'refresh-failed', conn: 'aaaa1111', rid: '33334444' },
      { ts: '2026-09-06T01:02:00Z', cls: 'UP', verdict: 'failover', conn: 'bbbb2222', rid: '33334444' },
    ]);
    const byCls = await call('?cls=CRED');
    expect(byCls.body.total).toBe(2);
    const byBoth = await call('?cls=CRED&verdict=refresh-failed');
    expect(byBoth.body.records).toHaveLength(1);
    expect(byBoth.body.records[0].rid).toBe('33334444');
    const byRid = await call('?rid=33334444');
    expect(byRid.body.total).toBe(2);
    const byConn = await call('?conn=bbbb2222');
    expect(byConn.body.records[0].cls).toBe('UP');
  });

  it('applies since and rejects a malformed one', async () => {
    writeRecords([
      { ts: '2026-09-06T00:00:00Z', cls: 'REQ', verdict: 'ok' },
      { ts: '2026-09-06T02:00:00Z', cls: 'REQ', verdict: 'ok' },
    ]);
    const res = await call('?since=2026-09-06T01:00:00Z');
    expect(res.body.total).toBe(1);
    const bad = await call('?since=yesterday');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_request');
  });

  it('caps at limit from the tail, newest-last', async () => {
    writeRecords(Array.from({ length: 10 }, (_, i) => ({ ts: `2026-09-06T00:0${i}:00Z`, cls: 'REQ', verdict: 'ok', n: i })));
    const res = await call('?limit=3');
    expect(res.body.total).toBe(10);
    expect(res.body.records.map((r) => r.n)).toEqual([7, 8, 9]);
  });

  it('skips a corrupt line instead of failing the request', async () => {
    fs.mkdirSync(path.dirname(sink()), { recursive: true });
    fs.writeFileSync(sink(), '{"ts":"2026-09-06T00:00:00Z","cls":"REQ","verdict":"ok"}\nnot json at all\n{"ts":"2026-09-06T00:01:00Z","cls":"REQ","verdict":"failed"}\n');
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });
});
