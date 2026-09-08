import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// D-11: the DRAIN verdict class was declared in decide.js but never emitted.
// POST /api/admin/drain/{connectionId} that actually starts a drain emits
// DRAIN.begin; DELETE that actually completes one emits DRAIN.end. The frozen
// ABI responses (docs/reconciliation/admin-abi.json) are untouched — the line
// is written after the state write, before the response. Idempotent no-op
// calls (already draining / not draining) emit nothing: no transition, no event.

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  readDrainDoc: vi.fn(),
  writeDrainDoc: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  },
}));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));
vi.mock('@/lib/admin/state.js', () => ({
  readDrainDoc: mocks.readDrainDoc,
  writeDrainDoc: mocks.writeDrainDoc,
  toDrainState: (connectionId, doc) => ({ connectionId, ...doc }),
  versionOf: (doc) => doc?.version ?? 0,
}));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.requireAdmin }));

import { __decide } from '@/shared/observability/decide.js';
import { DELETE, POST } from '@/app/api/admin/drain/[connectionId]/route.js';

let lines;
let spy;

const call = (handler, connectionId) =>
  handler(new Request(`http://localhost/api/admin/drain/${connectionId}`, { method: 'POST' }), {
    params: Promise.resolve({ connectionId }),
  });

beforeEach(() => {
  __decide.resetState();
  __decide.disableSink();
  lines = [];
  spy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
  mocks.requireAdmin.mockResolvedValue(null);
  mocks.getProviderConnectionById.mockResolvedValue({ id: 'conn-abc' });
  mocks.readDrainDoc.mockResolvedValue(null);
  mocks.writeDrainDoc.mockResolvedValue(undefined);
});

afterEach(() => {
  spy.mockRestore();
  vi.clearAllMocks();
});

describe('DRAIN decision lines (D-11)', () => {
  it('POST that starts a drain emits DRAIN.begin with the connection prefix', async () => {
    const res = await call(POST, 'conn-abc');
    expect(res.status).toBe(200);
    expect(res.body.isDraining).toBe(true);
    const line = lines.find((l) => l.includes('DRAIN.begin'));
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]{8}Z DRAIN\.begin conn=[0-9a-f]{8}$/);
  });

  it('idempotent POST on an already-draining connection stays silent', async () => {
    mocks.readDrainDoc.mockResolvedValue({ isDraining: true, requestedAt: '2026-09-03T00:00:00.000Z', completedAt: null });
    const res = await call(POST, 'conn-abc');
    expect(res.status).toBe(200);
    expect(mocks.writeDrainDoc).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('DRAIN.'))).toHaveLength(0);
  });

  it('DELETE that completes a drain emits DRAIN.end', async () => {
    mocks.readDrainDoc.mockResolvedValue({ isDraining: true, requestedAt: '2026-09-03T00:00:00.000Z', completedAt: null });
    const res = await call(DELETE, 'conn-abc');
    expect(res.status).toBe(200);
    expect(res.body.isDraining).toBe(false);
    const line = lines.find((l) => l.includes('DRAIN.end'));
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]{8}Z DRAIN\.end conn=[0-9a-f]{8}$/);
  });

  it('DELETE on a connection that is not draining stays silent', async () => {
    const res = await call(DELETE, 'conn-abc');
    expect(res.status).toBe(200);
    expect(mocks.writeDrainDoc).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('DRAIN.'))).toHaveLength(0);
  });

  it('DRAIN.begin and DRAIN.end for one connection carry the same conn prefix', async () => {
    await call(POST, 'conn-abc');
    mocks.readDrainDoc.mockResolvedValue({ isDraining: true, requestedAt: '2026-09-03T00:00:00.000Z', completedAt: null });
    await call(DELETE, 'conn-abc');
    const begin = lines.find((l) => l.includes('DRAIN.begin'));
    const end = lines.find((l) => l.includes('DRAIN.end'));
    expect(begin.split('conn=')[1]).toBe(end.split('conn=')[1]);
  });
});

// Isolate decision semantics from the separately qualified asynchronous transport.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
