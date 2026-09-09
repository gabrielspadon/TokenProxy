import { describe, it, expect, vi, beforeEach } from 'vitest';

// boundary-contract.json: operator.control.entry — owner "operator request
// handler", live_gate "operator status and drain reject normal clients".
// TokenProxy's operator-status read is GET /api/admin/drain (drain state per
// connection); its drain mutation is POST/DELETE /api/admin/drain/{id}. Both
// route through src/lib/admin/guard.js#requireAdmin, exercised here at the
// real exported route handlers — the same underlying gate
// tests/unit/reconciliation/admin-authz.test.js covers for its own (G3)
// contract id. This file is scoped to the two operator.control.entry
// mutations specifically, with its own independent mock scaffold so it does
// not depend on admin-authz.test.js existing or passing.
//
// Mutations this file must fail under if reintroduced:
//   - "accept normal client": an anonymous or inference-keyed caller is
//     admitted to operator status or to drain.
//   - "skip operator identity check": a caller whose CLI token value is wrong
//     is still admitted, because only the PRESENCE of a token was checked,
//     never its content.

const FAKE_INFERENCE_KEY = 'sk-test-notreal-0000-inference-eeeeeeee';
const FAKE_CLI_TOKEN = 'cli-test-notreal-0000-ffffffffffffffff';
const FAKE_WRONG_CLI_TOKEN = 'cli-test-notreal-0000-wrong-gggggggggg';
const PEER_TOKEN = 'peer-token-fixture-notreal-0001';

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

// One in-memory kv, standing in for the real table, so a rejected call's
// effect on drain state (none, if the gate holds) is directly observable.
const store = new Map();
const snapshot = () => JSON.stringify([...store.entries()].sort());

import { makeMemoryKv } from './kvMemory.js';

vi.mock('@/lib/db/helpers/kvStore.js', () => ({ makeKv: makeMemoryKv(store) }));

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
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ validateApiKey: mocks.validateApiKey }));
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

const { GET: DRAIN_LIST } = await import('@/app/api/admin/drain/route.js');
const { POST: DRAIN_ON, DELETE: DRAIN_OFF } =
  await import('@/app/api/admin/drain/[connectionId]/route.js');

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

const loopback = (pathname, opts = {}) =>
  request(pathname, {
    ...opts,
    headers: { 'x-tp-peer-token': PEER_TOKEN, 'x-tp-real-ip': '127.0.0.1', ...(opts.headers || {}) },
  });
const anonymous = (pathname, opts = {}) =>
  request(pathname, { ...opts, headers: { host: 'gateway.example.invalid', ...(opts.headers || {}) } });
const withInferenceKey = (pathname, opts = {}) =>
  anonymous(pathname, {
    ...opts,
    headers: { authorization: `Bearer ${FAKE_INFERENCE_KEY}`, ...(opts.headers || {}) },
  });
const withOperator = (pathname, opts = {}) =>
  loopback(pathname, { ...opts, headers: { 'x-tp-cli-token': FAKE_CLI_TOKEN, ...(opts.headers || {}) } });
const withWrongOperatorToken = (pathname, opts = {}) =>
  loopback(pathname, { ...opts, headers: { 'x-tp-cli-token': FAKE_WRONG_CLI_TOKEN, ...(opts.headers || {}) } });

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
});

describe('operator.control.entry — operator status rejects a normal client (mutation: accept normal client)', () => {
  it('refuses an anonymous read of drain status', async () => {
    const res = await DRAIN_LIST(anonymous('/api/admin/drain'));
    expect(res.status).toBe(401);
  });

  it('refuses an inference-keyed read of drain status', async () => {
    const res = await DRAIN_LIST(withInferenceKey('/api/admin/drain'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_class');
  });
});

describe('operator.control.entry — drain rejects a normal client (mutation: accept normal client)', () => {
  it('refuses an anonymous drain-on call and leaves drain state untouched', async () => {
    const before = snapshot();
    const res = await DRAIN_ON(anonymous('/api/admin/drain/conn-1', { method: 'POST' }), params('conn-1'));
    expect(res.status).toBe(401);
    expect(snapshot()).toBe(before);
  });

  it('refuses an inference-keyed drain-off call and leaves drain state untouched', async () => {
    const before = snapshot();
    const res = await DRAIN_OFF(
      withInferenceKey('/api/admin/drain/conn-1', { method: 'DELETE' }),
      params('conn-1'),
    );
    expect(res.status).toBe(403);
    expect(snapshot()).toBe(before);
  });
});

describe('operator.control.entry — identity content is verified, not merely its presence (mutation: skip operator identity check)', () => {
  it('refuses a loopback caller presenting the WRONG cli token on drain status', async () => {
    const res = await DRAIN_LIST(withWrongOperatorToken('/api/admin/drain'));
    expect(res.status).toBe(401);
  });

  it('refuses a loopback caller presenting the WRONG cli token on drain, and writes nothing', async () => {
    const before = snapshot();
    const res = await DRAIN_ON(
      withWrongOperatorToken('/api/admin/drain/conn-1', { method: 'POST' }),
      params('conn-1'),
    );
    expect(res.status).toBe(401);
    expect(snapshot()).toBe(before);
  });
});

describe('operator.control.entry — a genuine operator is admitted (the gate is real, not closed)', () => {
  it('serves drain status and lands a drain-on to a real operator', async () => {
    const statusRes = await DRAIN_LIST(withOperator('/api/admin/drain'));
    expect(statusRes.status).toBe(200);

    const before = snapshot();
    const res = await DRAIN_ON(withOperator('/api/admin/drain/conn-1', { method: 'POST' }), params('conn-1'));
    expect(res.status).toBe(200);
    expect(snapshot()).not.toBe(before);
  });
});
