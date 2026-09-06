import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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
import { createApiKey, matchesAllowedModel, updateApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import { rotateApiKey } from '@/lib/db/repos/keyLifecycleRepo.js';
import {
  CHECK_TIERS,
  RUNNABLE_TIERS,
  checkConfiguration,
  clientEndpoints,
} from '@/lib/clientSetup/connectivity.js';
import { GET as config, POST as check } from '@/app/api/keys/[id]/connectivity/route.js';

let db, key, fetchMock;
const request = (path, method = 'POST', body, headers = { 'x-operator': 'yes' }) =>
  new Request(`http://localhost:20128${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const context = () => ({ params: Promise.resolve({ id: key.id }) });
const run = async (body) =>
  check(request(`/api/keys/${key.id}/connectivity`, 'POST', body), context());

beforeAll(async () => {
  await initDb();
  db = await getAdapter();
});
beforeEach(async () => {
  db.run('DELETE FROM apiKeys');
  db.run('DELETE FROM operationEvents');
  key = await createApiKey('Client key', 'fixture-machine');
  // Every test in this file is offline. A real fetch here would be a live
  // request against whatever is listening on the port, which is the exact
  // thing the tier split exists to prevent.
  fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 200, statusText: 'OK' }));
});
afterEach(() => {
  fetchMock.mockRestore();
});

it('generates client endpoints without disclosing the key', async () => {
  const response = await config(request(`/api/keys/${key.id}/connectivity`, 'GET'), context());
  expect(response.status).toBe(200);
  expect(await response.clone().text()).not.toContain(key.key);
  const body = await response.json();
  expect(body.endpoints).toMatchObject({
    openaiBaseUrl: 'http://localhost:20128/v1',
    anthropicBaseUrl: 'http://localhost:20128',
    modelsUrl: 'http://localhost:20128/v1/models',
  });
  expect(body.keyPreview).toBe(`••••${key.key.slice(-4)}`);
  expect(fetchMock).not.toHaveBeenCalled();
});

// Tier 1 is not a weaker network test. It is a different question, and it
// reaches nothing at all.
it('runs the configuration tier without touching the network', async () => {
  const response = await run({ tier: 'configuration', model: 'openai/gpt-4o' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    tier: 'configuration',
    ok: true,
    reached: 'nothing',
    findings: [],
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('fails the configuration tier on an expired key, a paused key and a disallowed model', async () => {
  await updateApiKey(key.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  expect((await (await run({ tier: 'configuration' })).json()).findings).toMatchObject([
    { code: 'key_expired', severity: 'error' },
  ]);

  await updateApiKey(key.id, { expiresAt: null, isActive: false });
  expect((await (await run({ tier: 'configuration' })).json()).findings).toMatchObject([
    { code: 'key_paused', severity: 'error' },
  ]);

  await updateApiKey(key.id, { isActive: true, allowedModels: ['openai/gpt-4o'] });
  const scoped = await (await run({ tier: 'configuration', model: 'anthropic/claude-4' })).json();
  expect(scoped).toMatchObject({ ok: false });
  expect(scoped.findings).toMatchObject([{ code: 'model_not_allowed', severity: 'error' }]);
  expect(fetchMock).not.toHaveBeenCalled();
});

// A rotated key still works until its window closes. Saying it is broken is
// how a half-finished rotation gets abandoned.
it('reports a superseded key as a warning, not an error', async () => {
  await rotateApiKey(key.id, { overlapHours: 24 });
  const body = await (await run({ tier: 'configuration' })).json();
  expect(body.ok).toBe(true);
  expect(body.findings).toMatchObject([{ code: 'key_superseded', severity: 'warning' }]);
});

it('reaches only this gateway on the authentication tier and says so', async () => {
  const response = await run({ tier: 'authentication' });
  const body = await response.json();
  expect(body).toMatchObject({
    tier: 'authentication',
    ok: true,
    status: 200,
    reached: 'this gateway',
    provedNothingAbout: 'upstream provider availability or billing',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // The one request is this gateway's own catalog, never a provider and never
  // a completion endpoint.
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('http://localhost:20128/v1/models');
  expect(init.headers.authorization).toBe(`Bearer ${key.key}`);
});

// THE COST BOUNDARY. A billable request is refused outright rather than
// silently downgraded to a cheaper check that would report a misleading pass.
it('refuses the inference tier instead of downgrading it', async () => {
  const response = await run({ tier: 'inference' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'tier_not_runnable', tier: 'inference' });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(RUNNABLE_TIERS).not.toContain('inference');
  expect(CHECK_TIERS.inference.cost).toBe('billed');
});

it('refuses an unnamed or unrecognized tier rather than guessing one', async () => {
  for (const tier of [undefined, '', 'reachability', 'everything']) {
    const response = await run({ tier });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_tier');
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it('skips the network when the configuration already fails', async () => {
  await updateApiKey(key.id, { isActive: false });
  const body = await (await run({ tier: 'authentication' })).json();
  expect(body).toMatchObject({
    tier: 'authentication',
    ok: false,
    skipped: true,
    code: 'configuration_failed',
    reached: 'nothing',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('separates a timeout from a refused connection', async () => {
  fetchMock.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
  expect(await (await run({ tier: 'authentication' })).json()).toMatchObject({
    ok: false,
    timedOut: true,
  });

  fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
  expect(await (await run({ tier: 'authentication' })).json()).toMatchObject({
    ok: false,
    timedOut: false,
  });

  expect(
    db.all("SELECT code FROM operationEvents WHERE source='client-setup-check'").map((r) => r.code)
  ).toEqual(['probe_timeout', 'probe_failed']);
});

it('retains the check as an audit event carrying no key material', async () => {
  const response = await run({ tier: 'authentication' });
  expect(await response.text()).not.toContain(key.key);
  const events = db.all("SELECT * FROM operationEvents WHERE source='client-setup-check'");
  expect(events).toMatchObject([{ phase: 'reachability', state: 'succeeded', subjectId: key.id }]);
  expect(JSON.stringify(events)).not.toContain(key.key);
});

it('refuses an unauthorized caller at both entry points', async () => {
  for (const [headers, status] of [
    [{}, 401],
    [{ 'x-inference': 'yes' }, 403],
    [{ 'x-operator': 'yes', 'x-peer': 'remote' }, 403],
  ]) {
    expect(
      (
        await check(
          request(`/api/keys/${key.id}/connectivity`, 'POST', { tier: 'authentication' }, headers),
          context()
        )
      ).status
    ).toBe(status);
  }
  // GET is a read, so the loopback binding does not apply to it; the anonymous
  // and inference-only callers are still refused.
  for (const [headers, status] of [
    [{}, 401],
    [{ 'x-inference': 'yes' }, 403],
  ]) {
    expect(
      (
        await config(
          request(`/api/keys/${key.id}/connectivity`, 'GET', undefined, headers),
          context()
        )
      ).status
    ).toBe(status);
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it('checks configuration as a pure function with no key and no network', () => {
  expect(checkConfiguration({ baseUrl: 'not a url' }, null, matchesAllowedModel)).toMatchObject({
    ok: false,
    reached: 'nothing',
  });
  expect(
    checkConfiguration({ baseUrl: 'ftp://host' }, null, matchesAllowedModel).findings.map(
      (f) => f.code
    )
  ).toContain('unsupported_scheme');
  expect(clientEndpoints('http://host:1/')).toMatchObject({ openaiBaseUrl: 'http://host:1/v1' });
});
