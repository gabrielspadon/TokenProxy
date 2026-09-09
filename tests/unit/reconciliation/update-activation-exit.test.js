import { describe, it, expect, vi, beforeEach } from 'vitest';

// update.activation.exit — boundary-contract.json, owner claude/.claude/shared/bin/update-9router.sh
// "drained activation". Mutations this test must catch: "activate before
// drain", "start proxy before state seed", "discard data directory".
//
// The deploy script cuts a release over only after polling this exact set of
// admin-ABI reads — health, health/detail, the model catalog and the
// qualification pool — WHILE the connection being replaced is still
// draining, never after lifting the drain. This file drains a connection
// through the real ABI, activates a release while it is still draining, and
// proves all four reads answer honestly: health/detail tells the truth about
// a database that is not yet seeded rather than claiming ok ("start proxy
// before state seed"), activation never lifts a drain it has no business
// touching ("activate before drain"), and a release that predates this one
// survives the write ("discard data directory").
//
// Every fixture below is synthetic; nothing is read from the environment.

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getProviderConnectionById: vi.fn(),
  getProviderConnections: vi.fn(),
  getAdapter: vi.fn(),
}));

const store = new Map();

import { makeMemoryKv } from './kvMemory.js';

vi.mock('next/server', () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));
vi.mock('@/lib/db/helpers/kvStore.js', () => ({ makeKv: makeMemoryKv(store) }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db/version.js', () => ({ getAppVersion: () => '0.0.1' }));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: mocks.getProviderConnections,
  isConnectionDegraded: () => false,
}));
vi.mock('@/lib/db/driver.js', () => ({ getAdapter: mocks.getAdapter }));

const { POST: ACTIVATE, GET: ACTIVATION_GET } = await import('@/app/api/admin/activation/route.js');
const { POST: DRAIN_ON } = await import('@/app/api/admin/drain/[connectionId]/route.js');
const { GET: HEALTH } = await import('@/app/api/admin/health/route.js');
const { GET: HEALTH_DETAIL } = await import('@/app/api/admin/health/detail/route.js');
const { GET: MODELS } = await import('@/app/api/admin/models/route.js');
const { GET: QUALIFICATION } = await import('@/app/api/admin/qualification/route.js');

const req = (body) => ({ text: async () => (body === undefined ? '' : JSON.stringify(body)) });
const params = (connectionId) => ({ params: Promise.resolve({ connectionId }) });

const conn1 = { id: 'conn-1', provider: 'anthropic', isActive: true, testStatus: 'active' };
// .all() backs disabledModelsRepo's getDisabledModels(), which the models
// route consults; an empty set means nothing is filtered out of the catalog.
// swapDrainDoc runs the drain compare-and-set inside one adapter transaction
// over the kv table; this stub routes those reads and writes to the same map
// the makeKv mock uses, so the drain route sees exactly what state.js wrote.
const kvRow = (key) => { const v = store.get(`admin.drain:${key}`); return v === undefined ? undefined : { value: v }; };
const healthyDb = { driver: 'sql.js',
  get: vi.fn((sql, args) => /FROM kv/.test(sql) ? kvRow(args[0]) : ({ ok: 1 })),
  all: vi.fn(() => []),
  run: vi.fn((sql, args) => { if (/INSERT INTO kv/.test(sql)) store.set(`admin.drain:${args[0]}`, args[1]); }),
  transaction: (fn) => fn() };

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  mocks.requireAdmin.mockResolvedValue(null);
  mocks.getProviderConnectionById.mockResolvedValue(conn1);
  mocks.getProviderConnections.mockResolvedValue([conn1]);
  mocks.getAdapter.mockResolvedValue(healthyDb);

  // A release already on file before this deploy, the way an instance that
  // has shipped once actually looks.
  store.set(
    'admin.activation:current',
    JSON.stringify({
      releaseId: 'rel-1',
      version: '1.0.0',
      status: 'active',
      activatedAt: '2026-01-01T00:00:00.000Z',
      previousReleaseId: null,
    })
  );
  const history = [
    {
      releaseId: 'rel-1',
      version: '1.0.0',
      status: 'active',
      activatedAt: '2026-01-01T00:00:00.000Z',
      previousReleaseId: null,
      action: 'activate',
    },
    // The candidate release, staged and passed, ready to be cut over.
    {
      releaseId: 'rel-2',
      version: '2.0.0',
      status: 'pending',
      activatedAt: null,
      previousReleaseId: null,
    },
  ];
  store.set('admin.activation:history', JSON.stringify(history));
});

describe('update.activation.exit', () => {
  it('update.activation.exit: health, status, catalog and qualified pools all pass while the connection is still drained', async () => {
    // Drain the connection this release is replacing, through the real ABI.
    const drained = await DRAIN_ON(req(), params('conn-1'));
    expect(drained.status).toBe(200);
    expect((await drained.json()).isDraining).toBe(true);

    // Cut the new release over while that drain is still in effect.
    const activated = await ACTIVATE(req({ releaseId: 'rel-2' }));
    expect(activated.status).toBe(200);

    // Nothing lifted the drain — it is still in effect at this point.
    const health = await HEALTH(req());
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');

    const detail = await HEALTH_DETAIL(req());
    const detailBody = await detail.json();
    expect(detail.status).toBe(200);
    expect(detailBody.status).toBe('ok');
    const detailConn = detailBody.checks.connections.find((c) => c.connectionId === 'conn-1');
    expect(detailConn.isDraining).toBe(true);
    expect(detailConn.status).toBe('drained');

    const models = await MODELS(req());
    expect(models.status).toBe(200);
    expect((await models.json()).models.length).toBeGreaterThan(0);

    const qual = await QUALIFICATION(req());
    const qualBody = await qual.json();
    expect(qual.status).toBe(200);
    const qualConn = qualBody.connections.find((c) => c.connectionId === 'conn-1');
    expect(qualConn.isDraining).toBe(true);
  });

  it('update.activation.exit: activation never lifts a drain it did not request (activate before drain)', async () => {
    await DRAIN_ON(req(), params('conn-1'));
    await ACTIVATE(req({ releaseId: 'rel-2' }));

    const qual = await QUALIFICATION(req());
    const qualConn = (await qual.json()).connections.find((c) => c.connectionId === 'conn-1');
    expect(qualConn.isDraining).toBe(true);
    expect(qualConn.status).toBe('drained');
  });

  it('update.activation.exit: a release that predates this activation survives it (discard data directory)', async () => {
    await DRAIN_ON(req(), params('conn-1'));
    await ACTIVATE(req({ releaseId: 'rel-2' }));

    const after = await ACTIVATION_GET(req());
    const body = await after.json();
    expect(body.active.releaseId).toBe('rel-2');
    expect(body.history.some((r) => r.releaseId === 'rel-1')).toBe(true);
  });

  it('update.activation.exit: status detail reports error rather than a false ok when state is not yet seeded (start proxy before state seed)', async () => {
    await DRAIN_ON(req(), params('conn-1'));
    await ACTIVATE(req({ releaseId: 'rel-2' }));

    // The database a prematurely-started proxy has not finished seeding.
    mocks.getAdapter.mockRejectedValue(new Error('database not ready'));
    const detail = await HEALTH_DETAIL(req());
    const body = await detail.json();
    expect(detail.status).toBe(200);
    expect(body.status).toBe('error');
    expect(body.checks.database.status).toBe('error');
  });
});
