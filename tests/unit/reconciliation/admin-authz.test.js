import { describe, it, expect, vi, beforeEach } from 'vitest';

// G3 — an inference key cannot call a state-changing admin endpoint, and a
// missing, invalid or insufficient operator credential returns 401 or 403 and
// leaves quota, drain, activation and rollback state BYTE-IDENTICAL.
//
// The byte-identical half is the load-bearing one. A guard that rejects AFTER
// writing still returns 403, so a status-code-only test passes while the drain
// already landed. Every rejection case below therefore snapshots the entire
// backing store, makes the call, and asserts the serialized store is unchanged
// character for character.
//
// Both gates are exercised, because they are two layers with one rule:
// src/dashboardGuard.js refuses the request as middleware, and
// src/lib/admin/guard.js refuses it again inside every handler. A matcher edit
// or a directly-imported handler must not open a hole the other layer closes.
//
// Every credential fixture is SYNTHETIC and obviously fake. Nothing is read
// from the environment or from any config file.

const FAKE_INFERENCE_KEY = 'sk-test-notreal-0000-inference-aaaaaaaa';
const FAKE_BAD_KEY = 'sk-test-notreal-0000-revoked-bbbbbbbbb';
const FAKE_CLI_TOKEN = 'cli-test-notreal-0000-cccccccccccccccc';
const FAKE_SESSION_JWT = 'jwt-test-notreal-0000-dddddddddddddddd';
const PEER_TOKEN = 'peer-token-fixture-notreal-0000';

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol('next'),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  getProviderConnectionById: vi.fn(),
  getProviderConnections: vi.fn(),
  getWindows: vi.fn(),
  getAllWindows: vi.fn(),
  listSwitches: vi.fn(),
  testSingleConnection: vi.fn(),
}));

// ---------------------------------------------------------------- the store
//
// One in-memory kv, standing in for the real table. Both the drain scope and
// the activation scope live in it, so a single snapshot covers drain,
// activation and rollback state at once.
const store = new Map();
const snapshot = () => JSON.stringify([...store.entries()].sort());

vi.mock('@/lib/db/helpers/kvStore.js', () => ({
  makeKv: (scope) => ({
    async get(key, fallback = null) {
      const v = store.get(`${scope}:${key}`);
      return v === undefined ? fallback : JSON.parse(v);
    },
    async getAll() {
      const out = {};
      for (const [k, v] of store) {
        if (k.startsWith(`${scope}:`)) out[k.slice(scope.length + 1)] = JSON.parse(v);
      }
      return out;
    },
    async set(key, value) {
      store.set(`${scope}:${key}`, JSON.stringify(value));
    },
    async setMany(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(`${scope}:${k}`, JSON.stringify(v));
    },
    async remove(key) {
      store.delete(`${scope}:${key}`);
    },
    async clear() {
      for (const k of [...store.keys()]) if (k.startsWith(`${scope}:`)) store.delete(k);
    },
  }),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock('@/lib/localDb', () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ validateApiKey: mocks.validateApiKey, getExceededLimit:async()=>null }));
vi.mock('@/shared/utils/machineId', () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));
vi.mock('@/lib/auth/dashboardSession', () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: mocks.getProviderConnections,
  isConnectionDegraded: () => false,
}));
vi.mock('@/lib/db/repos/quotaWindowsRepo.js', () => ({
  getWindows: mocks.getWindows,
  getAllWindows: mocks.getAllWindows,
}));
vi.mock('@/lib/db/repos/accountSwitchRepo.js', () => ({ listSwitches: mocks.listSwitches, querySwitchesPage:mocks.listSwitches, getSwitchById:async(id)=>(await mocks.listSwitches({})).find(row=>row.id===id) || null }));
vi.mock('@/app/api/providers/[id]/test/testUtils', () => ({
  testSingleConnection: mocks.testSingleConnection,
}));
vi.mock('@/lib/db/version.js', () => ({ getAppVersion: () => '0.0.1' }));

const { proxy } = await import('@/dashboardGuard.js');
const { POST: DRAIN_ON, DELETE: DRAIN_OFF } =
  await import('@/app/api/admin/drain/[connectionId]/route.js');
const { GET: DRAIN_LIST } = await import('@/app/api/admin/drain/route.js');
const { GET: ACTIVATION_GET, POST: ACTIVATE } = await import('@/app/api/admin/activation/route.js');
const { POST: ROLLBACK } = await import('@/app/api/admin/rollback/route.js');
const { POST: RECHECK } =
  await import('@/app/api/admin/qualification/[connectionId]/recheck/route.js');
const { GET: QUOTA } = await import('@/app/api/admin/quota/route.js');
const { GET: HEALTH } = await import('@/app/api/admin/health/route.js');
const { GET: MODELS } = await import('@/app/api/admin/models/route.js');

// -------------------------------------------------------------- requests

function request(pathname, { method = 'GET', headers = {}, cookie, body, search = '' } = {}) {
  const url = `http://localhost${pathname}${search}`;
  return {
    method,
    url,
    nextUrl: { pathname, searchParams: new URL(url).searchParams },
    headers: new Headers(headers),
    cookies: { get: (name) => (cookie && name === 'auth_token' ? { value: cookie } : undefined) },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

// A request that actually arrived over the loopback socket: the peer IP is
// stamped by the server and proven with the per-process secret.
const loopback = (pathname, opts = {}) =>
  request(pathname, {
    ...opts,
    headers: {
      'x-tp-peer-token': PEER_TOKEN,
      'x-tp-real-ip': '127.0.0.1',
      ...(opts.headers || {}),
    },
  });

const anonymous = (pathname, opts = {}) =>
  request(pathname, {
    ...opts,
    headers: { host: 'gateway.example.invalid', ...(opts.headers || {}) },
  });

const withInferenceKey = (pathname, opts = {}) =>
  anonymous(pathname, {
    ...opts,
    headers: { authorization: `Bearer ${FAKE_INFERENCE_KEY}`, ...(opts.headers || {}) },
  });

const withOperator = (pathname, opts = {}) =>
  loopback(pathname, {
    ...opts,
    headers: { 'x-tp-cli-token': FAKE_CLI_TOKEN, ...(opts.headers || {}) },
  });

const params = (connectionId) => ({ params: Promise.resolve({ connectionId }) });

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  process.env.TOKENPROXY_PEER_TOKEN = PEER_TOKEN;

  mocks.getSettings.mockResolvedValue({ requireLogin: true });
  mocks.getConsistentMachineId.mockResolvedValue(FAKE_CLI_TOKEN);
  mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  // Only the one synthetic key is real; anything else is a revoked or forged key.
  mocks.validateApiKey.mockImplementation(async (key) => key === FAKE_INFERENCE_KEY);
  mocks.getProviderConnectionById.mockResolvedValue({
    id: 'conn-1',
    provider: 'anthropic',
    isActive: true,
    testStatus: 'active',
  });
  mocks.getProviderConnections.mockResolvedValue([
    { id: 'conn-1', provider: 'anthropic', isActive: true, testStatus: 'active' },
  ]);
  mocks.getWindows.mockResolvedValue([]);
  mocks.getAllWindows.mockResolvedValue(new Map());
  mocks.listSwitches.mockResolvedValue([]);
  mocks.testSingleConnection.mockResolvedValue({
    valid: true,
    latencyMs: 1,
    testedAt: '2026-01-01T00:00:00.000Z',
    error: null,
  });
});

// State the rejected calls must not disturb: a connection mid-drain, an
// activated release, and the history a rollback would walk.
async function seedState() {
  store.set(
    'admin.drain:conn-1',
    JSON.stringify({ isDraining: true, requestedAt: '2026-01-01T00:00:00.000Z', completedAt: null })
  );
  store.set(
    'admin.activation:current',
    JSON.stringify({
      releaseId: 'rel-2',
      version: '2.0.0',
      status: 'active',
      activatedAt: '2026-01-01T00:00:00.000Z',
      previousReleaseId: 'rel-1',
    })
  );
  store.set(
    'admin.activation:history',
    JSON.stringify([
      {
        releaseId: 'rel-2',
        version: '2.0.0',
        status: 'active',
        activatedAt: '2026-01-01T00:00:00.000Z',
        previousReleaseId: 'rel-1',
        action: 'activate',
      },
      {
        releaseId: 'rel-1',
        version: '1.0.0',
        status: 'rolled_back',
        activatedAt: '2025-12-01T00:00:00.000Z',
        previousReleaseId: null,
        action: 'activate',
      },
    ])
  );
}

// ------------------------------------------------------------ middleware

describe('the middleware gate on /api/admin', () => {
  it('refuses an anonymous operator-class read with 401', async () => {
    const res = await proxy(anonymous('/api/admin/drain'));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(res.body.source).toBe('tokenproxy-admin');
  });

  it('refuses an inference key on an operator-class read with 403', async () => {
    const res = await proxy(withInferenceKey('/api/admin/drain'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_class');
  });

  it('refuses an inference key on a state-changing endpoint with 403', async () => {
    const res = await proxy(withInferenceKey('/api/admin/drain/conn-1', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_class');
  });

  it('refuses an invalid, revoked-looking key exactly as it refuses no key at all', async () => {
    const res = await proxy(
      anonymous('/api/admin/drain/conn-1', {
        method: 'POST',
        headers: { authorization: `Bearer ${FAKE_BAD_KEY}` },
      })
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('refuses an operator who is not a loopback peer on a mutation', async () => {
    const res = await proxy(
      anonymous('/api/admin/drain/conn-1', {
        method: 'POST',
        headers: { 'x-tp-cli-token': FAKE_CLI_TOKEN },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_loopback');
  });

  it('admits a loopback operator on a mutation', async () => {
    const res = await proxy(withOperator('/api/admin/drain/conn-1', { method: 'POST' }));
    expect(res).toBe(mocks.nextResponse);
  });

  it('admits a dashboard session for an operator-class read', async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue({ sub: 'operator' });
    const res = await proxy(anonymous('/api/admin/quota', { cookie: FAKE_SESSION_JWT }));
    expect(res).toBe(mocks.nextResponse);
  });

  it('does not accept requireLogin=false as an operator credential', async () => {
    // An open dashboard is identity enough for a read elsewhere in this guard.
    // It is deliberately not identity enough to drain an account.
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    const res = await proxy(
      loopback('/api/admin/activation', { method: 'POST', body: { releaseId: 'rel-1' } })
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('admits an inference key on the two inference-class reads', async () => {
    for (const path of ['/api/admin/health', '/api/admin/models']) {
      expect(await proxy(withInferenceKey(path))).toBe(mocks.nextResponse);
    }
  });

  it('still refuses an anonymous caller on the inference-class reads', async () => {
    for (const path of ['/api/admin/health', '/api/admin/models']) {
      const res = await proxy(anonymous(path));
      expect(res.status).toBe(401);
    }
  });

  it('does not let /api/admin/health/detail ride the health prefix', async () => {
    const res = await proxy(withInferenceKey('/api/admin/health/detail'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_class');
  });

  it('treats a trailing slash as the same path', async () => {
    const res = await proxy(withInferenceKey('/api/admin/drain/'));
    expect(res.status).toBe(403);
  });
});

// ------------------------------------------------------- the handler gate

describe('the handler gate on /api/admin', () => {
  it('refuses each state-changing handler called directly without a credential', async () => {
    const calls = [
      () => DRAIN_ON(anonymous('/api/admin/drain/conn-1', { method: 'POST' }), params('conn-1')),
      () => DRAIN_OFF(anonymous('/api/admin/drain/conn-1', { method: 'DELETE' }), params('conn-1')),
      () =>
        ACTIVATE(
          anonymous('/api/admin/activation', { method: 'POST', body: { releaseId: 'rel-1' } })
        ),
      () => ROLLBACK(anonymous('/api/admin/rollback', { method: 'POST' })),
      () =>
        RECHECK(
          anonymous('/api/admin/qualification/conn-1/recheck', { method: 'POST' }),
          params('conn-1')
        ),
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBe(401);
      expect(res.body.source).toBe('tokenproxy-admin');
    }
  });

  it('refuses each state-changing handler holding only an inference key', async () => {
    const calls = [
      () =>
        DRAIN_ON(withInferenceKey('/api/admin/drain/conn-1', { method: 'POST' }), params('conn-1')),
      () =>
        DRAIN_OFF(
          withInferenceKey('/api/admin/drain/conn-1', { method: 'DELETE' }),
          params('conn-1')
        ),
      () =>
        ACTIVATE(
          withInferenceKey('/api/admin/activation', {
            method: 'POST',
            body: { releaseId: 'rel-1' },
          })
        ),
      () => ROLLBACK(withInferenceKey('/api/admin/rollback', { method: 'POST' })),
      () =>
        RECHECK(
          withInferenceKey('/api/admin/qualification/conn-1/recheck', { method: 'POST' }),
          params('conn-1')
        ),
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden_class');
    }
  });

  it('refuses an operator who is not a loopback peer on every mutation', async () => {
    const remoteOperator = (p, opts = {}) =>
      anonymous(p, {
        ...opts,
        headers: { 'x-tp-cli-token': FAKE_CLI_TOKEN, ...(opts.headers || {}) },
      });
    const calls = [
      () =>
        DRAIN_ON(remoteOperator('/api/admin/drain/conn-1', { method: 'POST' }), params('conn-1')),
      () =>
        ACTIVATE(
          remoteOperator('/api/admin/activation', { method: 'POST', body: { releaseId: 'rel-1' } })
        ),
      () => ROLLBACK(remoteOperator('/api/admin/rollback', { method: 'POST' })),
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden_loopback');
    }
  });

  it('refuses operator-class reads without an operator credential', async () => {
    expect((await DRAIN_LIST(anonymous('/api/admin/drain'))).status).toBe(401);
    expect((await QUOTA(withInferenceKey('/api/admin/quota'))).status).toBe(403);
    expect((await ACTIVATION_GET(anonymous('/api/admin/activation'))).status).toBe(401);
  });

  it('serves the inference-class reads to an inference key', async () => {
    expect((await HEALTH(withInferenceKey('/api/admin/health'))).status).toBe(200);
    expect((await MODELS(withInferenceKey('/api/admin/models'))).status).toBe(200);
  });
});

// ------------------------------------------------- byte-identical on refusal

describe('state is byte-identical after a rejected call', () => {
  // The failure this exists to catch is a guard that rejects AFTER writing:
  // the status code is right and the drain still landed.
  const rejected = [
    [
      'anonymous drain on',
      () => DRAIN_ON(anonymous('/api/admin/drain/conn-1', { method: 'POST' }), params('conn-1')),
    ],
    [
      'inference-key drain on',
      () =>
        DRAIN_ON(withInferenceKey('/api/admin/drain/conn-1', { method: 'POST' }), params('conn-1')),
    ],
    [
      'anonymous drain off',
      () => DRAIN_OFF(anonymous('/api/admin/drain/conn-1', { method: 'DELETE' }), params('conn-1')),
    ],
    [
      'inference-key drain off',
      () =>
        DRAIN_OFF(
          withInferenceKey('/api/admin/drain/conn-1', { method: 'DELETE' }),
          params('conn-1')
        ),
    ],
    [
      'anonymous activation',
      () =>
        ACTIVATE(
          anonymous('/api/admin/activation', { method: 'POST', body: { releaseId: 'rel-1' } })
        ),
    ],
    [
      'inference-key activation',
      () =>
        ACTIVATE(
          withInferenceKey('/api/admin/activation', {
            method: 'POST',
            body: { releaseId: 'rel-1' },
          })
        ),
    ],
    ['anonymous rollback', () => ROLLBACK(anonymous('/api/admin/rollback', { method: 'POST' }))],
    [
      'inference-key rollback',
      () => ROLLBACK(withInferenceKey('/api/admin/rollback', { method: 'POST' })),
    ],
    [
      'anonymous recheck',
      () =>
        RECHECK(
          anonymous('/api/admin/qualification/conn-1/recheck', { method: 'POST' }),
          params('conn-1')
        ),
    ],
    [
      'inference-key recheck',
      () =>
        RECHECK(
          withInferenceKey('/api/admin/qualification/conn-1/recheck', { method: 'POST' }),
          params('conn-1')
        ),
    ],
    [
      'remote operator drain on',
      () =>
        DRAIN_ON(
          anonymous('/api/admin/drain/conn-1', {
            method: 'POST',
            headers: { 'x-tp-cli-token': FAKE_CLI_TOKEN },
          }),
          params('conn-1')
        ),
    ],
    [
      'remote operator rollback',
      () =>
        ROLLBACK(
          anonymous('/api/admin/rollback', {
            method: 'POST',
            headers: { 'x-tp-cli-token': FAKE_CLI_TOKEN },
          })
        ),
    ],
  ];

  for (const [name, call] of rejected) {
    it(`leaves drain, activation and rollback state untouched: ${name}`, async () => {
      await seedState();
      const before = snapshot();

      const res = await call();
      expect([401, 403]).toContain(res.status);
      expect(snapshot()).toBe(before);
    });
  }

  it('spends no generation on a rejected recheck', async () => {
    await seedState();
    await RECHECK(
      withInferenceKey('/api/admin/qualification/conn-1/recheck', { method: 'POST' }),
      params('conn-1')
    );
    expect(mocks.testSingleConnection).not.toHaveBeenCalled();
  });

  it('reads no quota state on a rejected quota call', async () => {
    await QUOTA(withInferenceKey('/api/admin/quota'));
    expect(mocks.getAllWindows).not.toHaveBeenCalled();
  });

  it('leaves state untouched even when the rejected body would have been malformed', async () => {
    // Auth is decided before the body, so a caller cannot learn whether its
    // payload was well formed by watching which error comes back.
    await seedState();
    const before = snapshot();
    const res = await DRAIN_ON(
      withInferenceKey('/api/admin/drain/conn-1', {
        method: 'POST',
        body: { ifMatch: 12345, bogus: true },
      }),
      params('conn-1')
    );
    expect(res.status).toBe(403);
    expect(snapshot()).toBe(before);
  });

  it('changes state only once a loopback operator is accepted', async () => {
    await seedState();
    const before = snapshot();

    const rejectedRes = await DRAIN_OFF(
      withInferenceKey('/api/admin/drain/conn-1', { method: 'DELETE' }),
      params('conn-1')
    );
    expect(rejectedRes.status).toBe(403);
    expect(snapshot()).toBe(before);

    // Same operation, real operator credential, over loopback: now it lands.
    const acceptedRes = await DRAIN_OFF(
      withOperator('/api/admin/drain/conn-1', { method: 'DELETE' }),
      params('conn-1')
    );
    expect(acceptedRes.status).toBe(200);
    expect(snapshot()).not.toBe(before);
  });
});

// ------------------------------------------------- concurrency preconditions

describe('optimistic concurrency leaves state unchanged on conflict', () => {
  it('returns 412 with currentVersion and writes nothing when ifMatch is stale', async () => {
    await seedState();
    const before = snapshot();

    const res = await DRAIN_ON(
      withOperator('/api/admin/drain/conn-1', {
        method: 'POST',
        body: { ifMatch: 'stale-version' },
      }),
      params('conn-1')
    );

    expect(res.status).toBe(412);
    expect(res.body.code).toBe('version_conflict');
    expect(res.body.currentVersion).toBeTypeOf('string');
    expect(snapshot()).toBe(before);
  });

  it('returns 412 on a stale activation ifMatch and writes nothing', async () => {
    await seedState();
    const before = snapshot();

    const res = await ACTIVATE(
      withOperator('/api/admin/activation', {
        method: 'POST',
        body: { releaseId: 'rel-1', ifMatch: 'stale' },
      })
    );

    expect(res.status).toBe(412);
    expect(res.body.currentVersion).toBeTypeOf('string');
    expect(snapshot()).toBe(before);
  });

  it('rejects a malformed mutation body before reading any state', async () => {
    await seedState();
    const before = snapshot();

    const bad = await DRAIN_ON(
      withOperator('/api/admin/drain/conn-1', { method: 'POST', body: { ifMatch: 99 } }),
      params('conn-1')
    );
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_request');

    const unknownField = await DRAIN_ON(
      withOperator('/api/admin/drain/conn-1', { method: 'POST', body: { drainNow: true } }),
      params('conn-1')
    );
    expect(unknownField.status).toBe(400);

    expect(snapshot()).toBe(before);
  });

  it('has nothing to roll back to on a fresh instance, and says so without writing', async () => {
    const before = snapshot();
    const res = await ROLLBACK(withOperator('/api/admin/rollback', { method: 'POST' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_prior_release');
    expect(snapshot()).toBe(before);
  });

  it('is 404 for an unknown release, and writes nothing', async () => {
    await seedState();
    const before = snapshot();
    const res = await ACTIVATE(
      withOperator('/api/admin/activation', {
        method: 'POST',
        body: { releaseId: 'rel-does-not-exist' },
      })
    );
    expect(res.status).toBe(404);
    expect(snapshot()).toBe(before);
  });

  it('is 404 for a drain on a connection that does not exist, and writes nothing', async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);
    const before = snapshot();
    const res = await DRAIN_ON(
      withOperator('/api/admin/drain/ghost', { method: 'POST' }),
      params('ghost')
    );
    expect(res.status).toBe(404);
    expect(snapshot()).toBe(before);
  });
});
