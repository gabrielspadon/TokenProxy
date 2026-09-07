import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/dashboardGuard', () => ({
  hasValidCliToken: vi.fn(async (request) => request.headers.get('x-operator') === 'yes'),
  isLocalRequest: (request) => request.headers.get('x-peer') !== 'remote',
}));
vi.mock('@/lib/auth/dashboardSession', () => ({
  verifyDashboardAuthToken: vi.fn(async () => false),
}));
vi.mock('@/lib/auth/clientApiKey', () => ({
  resolveClientApiKey: vi.fn(async (request) => ({ valid: request.headers.has('x-inference') })),
}));
vi.mock('@/shared/utils/machineId', () => ({
  getConsistentMachineId: vi.fn(async () => 'fixture-machine'),
}));
import { initDb } from '@/lib/db/index.js';
import { getAdapter } from '@/lib/db/driver.js';
import { createApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import * as list from '@/app/api/keys/route.js';
import * as detail from '@/app/api/keys/[id]/route.js';
import { GET as devices } from '@/app/api/keys/devices/route.js';
import { POST as reveal } from '@/app/api/keys/[id]/reveal/route.js';

let db, key;
const request = (path = '/api/keys', method = 'GET', body, headers = { 'x-operator': 'yes' }) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const context = () => ({ params: Promise.resolve({ id: key.id }) });
const events = () => db.all("SELECT * FROM operationEvents WHERE subjectKind='apiKey' ORDER BY id");

beforeAll(async () => {
  await initDb();
  db = await getAdapter();
});
beforeEach(async () => {
  db.run('DELETE FROM apiKeys');
  db.run('DELETE FROM operationEvents');
  key = await createApiKey('Fixture key', 'fixture-machine');
});

// The one invariant a browser must never be trusted to keep. Every response
// that enumerates keys is swept for the stored material itself, so a future
// field carrying `key` through fails here rather than in a leaked screenshot.
it('never returns stored key material from any enumerating response', async () => {
  const responses = [
    await list.GET(request()),
    await detail.GET(request(`/api/keys/${key.id}`), context()),
    await detail.PUT(request(`/api/keys/${key.id}`, 'PUT', { isActive: false }), context()),
    await devices(request('/api/keys/devices')),
  ];
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(key.key);
  }
  // Enumeration is not an auditable disclosure, so it writes no event: an audit
  // trail that fires on every 15-second poll is one nobody reads.
  expect(events()).toHaveLength(0);
});

it('retains an audit event for the disclosure, carrying no key material', async () => {
  const response = await reveal(request(`/api/keys/${key.id}/reveal`, 'POST'), context());
  expect(response.status).toBe(200);
  expect((await response.json()).key).toBe(key.key);

  const [event, ...rest] = events();
  expect(rest).toHaveLength(0);
  expect(event).toMatchObject({
    phase: 'authentication',
    state: 'succeeded',
    source: 'api-key-reveal',
    actorClass: 'operator',
    subjectKind: 'apiKey',
    subjectId: key.id,
    code: 'credential_disclosed',
  });
  // The audit row records THAT the secret was disclosed, never the secret.
  expect(JSON.stringify(event)).not.toContain(key.key);
  expect(JSON.parse(event.details)).toMatchObject({ kind: 'credential-disclosure' });
});

it('records a failed disclosure for an id that resolves to no key', async () => {
  const response = await reveal(request('/api/keys/missing/reveal', 'POST'), {
    params: Promise.resolve({ id: 'missing' }),
  });
  expect(response.status).toBe(404);
  expect(events()).toMatchObject([
    { state: 'failed', code: 'key_not_found', subjectId: 'missing' },
  ]);
});

// Fail closed. A disclosure whose audit row cannot be written does not happen:
// the operator retries, rather than the gateway handing out a credential that
// left no trace.
it('refuses to disclose when the audit event cannot be retained', async () => {
  const repo = await import('@/lib/db/repos/operationEventsRepo.js');
  const spy = vi
    .spyOn(repo, 'recordOperationTerminal')
    .mockRejectedValueOnce(new Error('retention unavailable'));
  const response = await reveal(request(`/api/keys/${key.id}/reveal`, 'POST'), context());
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain(key.key);
  spy.mockRestore();
});

it('writes no audit event for a disclosure the guard refused', async () => {
  for (const headers of [
    {},
    { 'x-inference': 'yes' },
    { 'x-operator': 'yes', 'x-peer': 'remote' },
  ]) {
    const response = await reveal(
      request(`/api/keys/${key.id}/reveal`, 'POST', undefined, headers),
      context()
    );
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(await response.text()).not.toContain(key.key);
  }
  expect(events()).toHaveLength(0);
});
