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
import {
  createApiKey,
  getApiKeyById,
  updateApiKey,
  validateApiKey,
} from '@/lib/db/repos/apiKeysRepo.js';
import { createAccessProfile } from '@/lib/db/repos/accessProfilesRepo.js';
import { adoptAccessProfile, rotateApiKey } from '@/lib/db/repos/keyLifecycleRepo.js';
import { POST as rotate } from '@/app/api/keys/[id]/rotate/route.js';
import * as list from '@/app/api/keys/route.js';

let db, key;
const request = (path, method = 'POST', body, headers = { 'x-operator': 'yes' }) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const context = () => ({ params: Promise.resolve({ id: key.id }) });

beforeAll(async () => {
  await initDb();
  db = await getAdapter();
});
beforeEach(async () => {
  db.run('DELETE FROM apiKeys');
  db.run('DELETE FROM apiKeyRotations');
  db.run('DELETE FROM operationEvents');
  key = await createApiKey('Client key', 'fixture-machine');
});

// The whole point of the feature: the old secret does NOT stop working the
// moment the new one is issued.
it('keeps the old secret valid for the chosen overlap window', async () => {
  const result = await rotateApiKey(key.id, { overlapHours: 48 });
  expect(result.successor.key).not.toBe(key.key);
  expect(await validateApiKey(key.key)).toBe(true);
  expect(await validateApiKey(result.successor.key)).toBe(true);

  const previous = await getApiKeyById(key.id);
  expect(previous.isActive).toBe(true);
  expect(previous.supersededAt).toBeTruthy();
  const hours = (new Date(previous.expiresAt) - Date.now()) / 3600000;
  expect(hours).toBeGreaterThan(47.9);
  expect(hours).toBeLessThan(48.1);
  expect(previous.expiresAt).toBe(result.overlapEndsAt);
});

it('stops the old secret once the window has passed, leaving the successor working', async () => {
  const result = await rotateApiKey(key.id, { overlapHours: 1 });
  // Move the deadline into the past rather than waiting an hour. Expiry is
  // enforced at request-auth time, so no sweep has to have run.
  await updateApiKey(key.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  expect(await validateApiKey(key.key)).toBe(false);
  expect(await validateApiKey(result.successor.key)).toBe(true);
});

// Allowed, because an operator responding to a leak needs it, but never the
// default and never reached by omission.
it('supports a zero-hour window as an explicit choice, and requires the choice', async () => {
  const result = await rotateApiKey(key.id, { overlapHours: 0 });
  expect(await validateApiKey(key.key)).toBe(false);
  expect(await validateApiKey(result.successor.key)).toBe(true);

  const refused = await rotate(request(`/api/keys/${key.id}/rotate`, 'POST', {}), context());
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain('overlapHours');
});

it('refuses an out-of-range window and a second rotation of the same key', async () => {
  await expect(rotateApiKey(key.id, { overlapHours: -1 })).rejects.toMatchObject({ status: 400 });
  await expect(rotateApiKey(key.id, { overlapHours: 99999 })).rejects.toMatchObject({
    status: 400,
  });
  await rotateApiKey(key.id, { overlapHours: 2 });
  await expect(rotateApiKey(key.id, { overlapHours: 2 })).rejects.toMatchObject({ status: 409 });
});

// Rotating must never be a way to quietly buy a credential more life than the
// operator originally granted it.
it('never extends a key past an expiry it already had', async () => {
  const soon = new Date(Date.now() + 3600000).toISOString();
  await updateApiKey(key.id, { expiresAt: soon });
  const result = await rotateApiKey(key.id, { overlapHours: 72 });
  expect(result.overlapEndsAt).toBe(soon);
  expect(result.overlapTruncatedByExistingExpiry).toBe(true);
  expect((await getApiKeyById(key.id)).expiresAt).toBe(soon);
});

it("carries the predecessor's access settings and profile linkage onto the successor", async () => {
  const profile = await createAccessProfile({
    name: 'Bundle',
    allowedModels: ['openai/gpt-4o'],
    maxCostUsd: 5,
  });
  await adoptAccessProfile(key.id, profile.id);
  const result = await rotateApiKey(key.id, { overlapHours: 12 });
  expect(await getApiKeyById(result.successor.id)).toMatchObject({
    allowedModels: ['openai/gpt-4o'],
    maxCostUsd: 5,
    accessProfileId: profile.id,
    accessProfileVersion: 1,
  });
});

it('returns the successor secret once and never through the list', async () => {
  const response = await rotate(
    request(`/api/keys/${key.id}/rotate`, 'POST', { overlapHours: 24 }),
    context()
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.successor.key).toBeTruthy();
  const listed = await list.GET(
    new Request('http://localhost/api/keys', { headers: { 'x-operator': 'yes' } })
  );
  const text = await listed.clone().text();
  expect(text).not.toContain(body.successor.key);
  expect(text).not.toContain(key.key);

  // Both sides of the rotation are legible from the list.
  const rows = (await listed.json()).keys;
  expect(rows.find((r) => r.id === key.id).rotation).toMatchObject({
    role: 'superseded',
    counterpartKeyId: body.successor.id,
  });
  expect(rows.find((r) => r.id === body.successor.id).rotation).toMatchObject({
    role: 'successor',
    counterpartKeyId: key.id,
  });
});

it('retains an audit event for the rotation, carrying neither secret', async () => {
  const response = await rotate(
    request(`/api/keys/${key.id}/rotate`, 'POST', { overlapHours: 6 }),
    context()
  );
  const body = await response.json();
  const events = db.all("SELECT * FROM operationEvents WHERE source='api-key-rotation'");
  expect(events).toMatchObject([
    { state: 'succeeded', code: 'credential_rotated', subjectId: key.id },
  ]);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(key.key);
  expect(serialized).not.toContain(body.successor.key);
});

it('refuses rotation from an unauthorized caller and leaves the key untouched', async () => {
  for (const [headers, status] of [
    [{}, 401],
    [{ 'x-inference': 'yes' }, 403],
    [{ 'x-operator': 'yes', 'x-peer': 'remote' }, 403],
  ]) {
    const response = await rotate(
      request(`/api/keys/${key.id}/rotate`, 'POST', { overlapHours: 1 }, headers),
      context()
    );
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(key.key);
  }
  expect((await getApiKeyById(key.id)).supersededAt).toBeNull();
  expect(db.all('SELECT * FROM apiKeyRotations')).toHaveLength(0);
});
