import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ operator: true, inference: false, loopback: true }));
vi.mock('@/dashboardGuard', () => ({ hasValidCliToken: async () => auth.operator, isLocalRequest: () => auth.loopback }));
vi.mock('@/lib/auth/dashboardSession', () => ({ verifyDashboardAuthToken: async () => false }));
vi.mock('@/lib/auth/clientApiKey', () => ({ resolveClientApiKey: async () => ({ valid: auth.inference }) }));
vi.mock('@/lib/admin/authzLog.js', () => ({ logAdminAuthz: vi.fn() }));

import { POST } from '@/app/api/admin/routing-simulator/[operation]/route.js';
import { getAdapter } from '@/lib/db/driver.js';
import { createProviderConnection } from '@/lib/db/repos/connectionsRepo.js';
import { createProviderNode } from '@/lib/db/repos/nodesRepo.js';
import { disableModels } from '@/lib/db/repos/disabledModelsRepo.js';
import { setPin } from '@/lib/db/repos/sessionAffinityRepo.js';
import { leaseRegistry } from '@/sse/services/accountLeaseRegistry.js';

let db, connection;
const MODEL = 'claude-fable-5', input = { model: `claude/${MODEL}`, contextTokens: 9000, requiredCapabilities: ['reasoning'] };
const sessionHash = 'a'.repeat(64);
beforeAll(async () => {
  expect(process.env.DATA_DIR).toMatch(/tokenproxy-test-file-/);
  db = await getAdapter();
  connection = await createProviderConnection({ provider: 'claude', authType: 'oauth', name: 'private-name', email: 'private@example.test',
    accessToken: 'never-return-me', refreshToken: 'never-refresh-me', isActive: true,
    providerSpecificData: { enabledModels: [MODEL] } });
  await setPin(sessionHash, MODEL, connection.id);
});
beforeEach(() => { Object.assign(auth, { operator: true, inference: false, loopback: true });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No transport permitted'); })); });
afterAll(() => { vi.unstubAllGlobals(); });
async function call(operation, body, { raw, query = '', headers = {} } = {}) {
  const response = await POST(new Request(`http://localhost/api/admin/routing-simulator/${operation}${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body),
  }), { params: Promise.resolve({ operation }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
it('captures real repository state and exact existing pin, validates and simulates without writes or leases', async () => {
  const before = db.get('SELECT total_changes() AS n').n, held = leaseRegistry.snapshot();
  const captured = await call('capture', { input, sessionHash });
  expect(captured.status).toBe(200);
  expect(captured.body.capture.pin.connectionId).toBe(connection.id);
  expect(captured.body.capture.affinitySource).toBe('captured-session');
  expect(JSON.stringify(captured.body)).not.toMatch(/never-return|never-refresh|private-name|private@example|aaaaaaaaaaaa/);
  const packet = { input, capture: captured.body.capture };
  expect((await call('validate', packet)).body.valid).toBe(true);
  const simulated = await call('simulate', packet);
  expect(simulated.status).toBe(200);
  expect(simulated.body.localSelection).toMatchObject({ connectionId: connection.id, reason: 'pinned' });
  expect(simulated.body.served).toBeNull();
  expect(simulated.body.readiness).toBe('unknown');
  expect(simulated.headers.get('cache-control')).toBe('no-store');
  expect(db.get('SELECT total_changes() AS n').n).toBe(before);
  expect(leaseRegistry.snapshot()).toEqual(held);
  expect(fetch).not.toHaveBeenCalled();
});
it('requires operator class and loopback before reading capture bodies', async () => {
  const before = db.get('SELECT total_changes() AS n').n;
  for (const [operator, inference, loopback, expected] of [[false, false, true, 401], [false, true, true, 403], [true, false, false, 403]]) {
    Object.assign(auth, { operator, inference, loopback });
    expect((await call('capture', null, { raw: 'malformed secret body' })).status).toBe(expected);
  }
  expect(db.get('SELECT total_changes() AS n').n).toBe(before);
  expect(fetch).not.toHaveBeenCalled();
});
it('bounds declared and actual bodies, query fields, IDs, unsupported routes and malformed nested state', async () => {
  expect((await call('capture', { input }, { query: '?unknown=1&unknown=2' })).status).toBe(400);
  expect((await call('capture', { input, secret: 'hidden' })).status).toBe(400);
  expect((await call('capture', { input, sessionHash: 'not-hash' })).status).toBe(400);
  expect((await call('capture', { input: { model: 'auto' } })).status).toBe(422);
  expect((await call('capture', { input: { model: 'auto-router' } })).status).toBe(422);
  expect((await call('capture', { input: { model: 'tokenproxy/auto-router' } })).status).toBe(422);
  expect((await call('capture', { input }, { headers: { 'content-length': '1048577' } })).status).toBe(413);
  expect((await call('capture', {}, { raw: 'x'.repeat(1048577) })).status).toBe(413);
  const secret = await call('simulate', {}, { raw: '{"password":"top-secret"' });
  expect(secret.status).toBe(400);
  expect(JSON.stringify(secret.body)).not.toContain('top-secret');
  const large = await call('capture', { input: { model: 'a'.repeat(513) } });
  expect(large.status).toBe(400);
});
it('resolves configured prefix shadows and enforces that node account policy', async () => {
  const node = await createProviderNode({ type: 'openai-compatible', prefix: 'cc', name: 'private-node', baseUrl: 'https://private.invalid/v1' });
  const a = await createProviderConnection({ provider: node.id, authType: 'apikey', apiKey: 'secret-node-key', isActive: true });
  await disableModels(node.id, [MODEL], a.id);
  const nodeInput = { model: `cc/${MODEL}` };
  const captured = await call('capture', { input: nodeInput });
  expect(captured.status).toBe(200);
  expect(captured.body.capture.scope.provider).toBe(node.id);
  const result = await call('simulate', { input: nodeInput, capture: captured.body.capture });
  expect(result.body.exclusions).toContainEqual({ connectionId: a.id, reason: 'model-disabled' });
  expect(result.body.localSelection.connectionId).toBeNull();
  expect(JSON.stringify(captured.body)).not.toMatch(/secret-node-key|private\.invalid|private-node/);
  const canonical = await call('capture', { input });
  expect(canonical.status).toBe(200);
  expect((await call('simulate', { input, capture: canonical.body.capture })).body.localSelection.connectionId).toBe(connection.id);
  expect(fetch).not.toHaveBeenCalled();
});
