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
import { createApiKey, getApiKeyById, updateApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import {
  createAccessProfile,
  getAccessProfiles,
  deleteAccessProfile,
  profileComplianceFor,
  updateAccessProfile,
} from '@/lib/db/repos/accessProfilesRepo.js';
import { adoptAccessProfile, releaseAccessProfile } from '@/lib/db/repos/keyLifecycleRepo.js';
import * as list from '@/app/api/keys/route.js';
import * as keyRoute from '@/app/api/keys/[id]/route.js';
import * as profileRoute from '@/app/api/access-profiles/[id]/route.js';

let db, key;
const request = (path = '/api/keys', method = 'GET', body, headers = { 'x-operator': 'yes' }) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const compliance = async (id) => profileComplianceFor(db, await getApiKeyById(id));

beforeAll(async () => {
  await initDb();
  db = await getAdapter();
});
beforeEach(async () => {
  db.run('DELETE FROM apiKeys');
  db.run('DELETE FROM accessProfiles');
  db.run('DELETE FROM accessProfileVersions');
  key = await createApiKey('Fixture key', 'fixture-machine');
});

const PROFILE = {
  name: 'Read-only agents',
  allowedModels: ['openai/gpt-4o'],
  maxCostUsd: 5,
  budgetPolicy: 'strict',
};

it('refuses stale edits and deletes without changing a profile or adopting keys', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  await updateAccessProfile(profile.id, { maxCostUsd: 8, expectedVersion: 1 });
  const params = { params: Promise.resolve({ id: profile.id }) };
  const edit = await profileRoute.PUT(request(`/api/access-profiles/${profile.id}`, 'PUT', { expectedVersion: 1, maxCostUsd: 99 }), params);
  expect(edit.status).toBe(409);
  const deletion = await profileRoute.DELETE(request(`/api/access-profiles/${profile.id}?expectedVersion=1`, 'DELETE'), params);
  expect(deletion.status).toBe(409);
  expect((await getAccessProfiles())[0]).toMatchObject({ version: 2, maxCostUsd: 8, keyCount: 1 });
  expect((await getApiKeyById(key.id)).maxCostUsd).toBe(5);
});

it('refuses a stale rename even when policy version did not change', async () => {
  const profile = await createAccessProfile(PROFILE);
  await updateAccessProfile(profile.id, { name: 'Changed label' });
  await expect(updateAccessProfile(profile.id, { name: 'Stale editor', expectedName: PROFILE.name, expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
  await expect(deleteAccessProfile(profile.id, 1, PROFILE.name)).rejects.toMatchObject({ status: 409 });
  expect((await getAccessProfiles())[0].name).toBe('Changed label');
});

it('refuses fractional expiry days rather than issuing an immediately expired key', async () => {
  await expect(createAccessProfile({ ...PROFILE, expiryDays: 0.5 })).rejects.toMatchObject({ status: 400 });
  expect(await getAccessProfiles()).toEqual([]);
});

it('sets and clears existing key expiry through the redacted operator API', async () => {
  const params = { params: Promise.resolve({ id: key.id }) };
  const expiresAt = '2030-01-02T03:04:05.000Z';
  const set = await keyRoute.PUT(request(`/api/keys/${key.id}`, 'PUT', { expiresAt }), params);
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({ key: { expiresAt, secretRedacted: true } });
  expect((await getApiKeyById(key.id)).expiresAt).toBe(expiresAt);
  const clear = await keyRoute.PUT(request(`/api/keys/${key.id}`, 'PUT', { expiresAt: null }), params);
  expect(clear.status).toBe(200);
  expect((await getApiKeyById(key.id)).expiresAt).toBeNull();
});

it.each(['garbage', '', '2030-02-30T00:00:00Z', 0, {}, '2030-01-02'])('refuses invalid expiry %j without silently removing it', async invalid => {
  const expiresAt = '2030-01-02T03:04:05.000Z';
  await updateApiKey(key.id, { expiresAt });
  const result = await keyRoute.PUT(request(`/api/keys/${key.id}`, 'PUT', { expiresAt: invalid }), { params: Promise.resolve({ id: key.id }) });
  expect(result.status).toBe(400);
  expect((await getApiKeyById(key.id)).expiresAt).toBe(expiresAt);
});

it('refuses expiry writes from inference callers and remote operators', async () => {
  for (const headers of [{ 'x-inference': 'yes' }, { 'x-operator': 'yes', 'x-peer': 'remote' }]) {
    const result = await keyRoute.PUT(request(`/api/keys/${key.id}`, 'PUT', { expiresAt: '2030-01-02T03:04:05Z' }, headers), { params: Promise.resolve({ id: key.id }) });
    expect(result.status).toBe(403);
  }
  expect((await getApiKeyById(key.id)).expiresAt).toBeNull();
});

it("copies the profile's settings onto the key at adoption", async () => {
  const profile = await createAccessProfile(PROFILE);
  expect(profile.version).toBe(1);
  const adopted = await adoptAccessProfile(key.id, profile.id);
  expect(adopted).toMatchObject({
    allowedModels: ['openai/gpt-4o'],
    maxCostUsd: 5,
    accessProfileId: profile.id,
    accessProfileVersion: 1,
  });
  expect(await compliance(key.id)).toMatchObject({
    drifted: false,
    behind: false,
    driftedFields: [],
  });
});

// Days rather than a date, so one bundle can be adopted repeatedly over months
// without ever handing out an already-past expiry.
it("resolves the profile's expiry policy to a date on the key", async () => {
  const profile = await createAccessProfile({ ...PROFILE, expiryDays: 30 });
  const adopted = await adoptAccessProfile(key.id, profile.id);
  const days = (new Date(adopted.expiresAt) - Date.now()) / 86400000;
  expect(days).toBeGreaterThan(29.9);
  expect(days).toBeLessThan(30.1);
});

it("leaves the key's own expiry alone when the profile requires none", async () => {
  await updateApiKey(key.id, { expiresAt: '2030-01-01T00:00:00.000Z' });
  const profile = await createAccessProfile(PROFILE);
  expect((await adoptAccessProfile(key.id, profile.id)).expiresAt).toBe('2030-01-01T00:00:00.000Z');
});

it('reports a hand-edited key as drifted, naming the fields', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  await updateApiKey(key.id, { maxCostUsd: 500 });
  expect(await compliance(key.id)).toMatchObject({
    drifted: true,
    behind: false,
    driftedFields: ['maxCostUsd'],
  });
});

// The two signals are never collapsed: an operator edited this key, versus the
// bundle moved on since. They call for different actions.
it('reports a key as behind without calling it drifted when the profile advances', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  const updated = await updateAccessProfile(profile.id, { maxCostUsd: 25 });
  expect(updated.version).toBe(2);
  expect(await compliance(key.id)).toMatchObject({
    adoptedVersion: 1,
    currentVersion: 2,
    behind: true,
    drifted: false,
  });
  // The live key was NOT rewritten by the profile edit.
  expect((await getApiKeyById(key.id)).maxCostUsd).toBe(5);
});

it('does not mint a version for a rename alone', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  expect((await updateAccessProfile(profile.id, { name: 'Renamed' })).version).toBe(1);
  expect(await compliance(key.id)).toMatchObject({
    behind: false,
    drifted: false,
    profileName: 'Renamed',
  });
});

it('re-adopting the current version clears both signals', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  await updateAccessProfile(profile.id, { maxCostUsd: 25 });
  await updateApiKey(key.id, { maxPromptTokens: 7 });
  expect(await compliance(key.id)).toMatchObject({ behind: true, drifted: true });
  await adoptAccessProfile(key.id, profile.id);
  expect(await compliance(key.id)).toMatchObject({
    behind: false,
    drifted: false,
    adoptedVersion: 2,
  });
  expect((await getApiKeyById(key.id)).maxCostUsd).toBe(25);
});

// Deleting a bundle removes the bundle, never the access it granted.
it('releases keys without changing their settings when a profile is deleted', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  expect(await deleteAccessProfile(profile.id)).toBe(true);
  const after = await getApiKeyById(key.id);
  expect(after).toMatchObject({
    maxCostUsd: 5,
    allowedModels: ['openai/gpt-4o'],
    accessProfileId: null,
  });
  expect(profileComplianceFor(db, after)).toBeNull();
});

it('keeps every adopted setting when a key stops following a profile', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  const released = await releaseAccessProfile(key.id);
  expect(released).toMatchObject({
    maxCostUsd: 5,
    accessProfileId: null,
    accessProfileVersion: null,
  });
});

it('refuses a duplicate profile name and an unparseable ceiling', async () => {
  await createAccessProfile(PROFILE);
  await expect(createAccessProfile(PROFILE)).rejects.toMatchObject({ status: 409 });
  await expect(createAccessProfile({ name: 'Bad', maxCostUsd: -1 })).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    createAccessProfile({ name: 'Bad', budgetPolicy: 'whatever' })
  ).rejects.toMatchObject({ status: 400 });
});

it('counts the keys following each profile without disclosing key material', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  const profiles = await getAccessProfiles();
  expect(profiles).toMatchObject([{ id: profile.id, keyCount: 1, version: 1 }]);
  expect(JSON.stringify(profiles)).not.toContain(key.key);
});

it('carries compliance on the keys list without the secret', async () => {
  const profile = await createAccessProfile(PROFILE);
  await adoptAccessProfile(key.id, profile.id);
  await updateApiKey(key.id, { maxCostUsd: 99 });
  const response = await list.GET(request());
  expect(await response.clone().text()).not.toContain(key.key);
  const row = (await response.json()).keys[0];
  expect(row.profile).toMatchObject({
    profileId: profile.id,
    profileName: 'Read-only agents',
    drifted: true,
    driftedFields: ['maxCostUsd'],
  });
});
