import { test, expect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { signIn } from './helpers.mjs';

const KIND = 'synthetic-fixture';
const PROFILE = 'Synthetic fixture access policy';
const KEY = 'Synthetic fixture lifecycle key';
const POOL = 'Synthetic fixture policy pool';
const dialog = page => page.locator('dialog[open]');
const assertPreview = response => expect(response.headers()['x-tokenproxy-preview-kind']).toBe(KIND);
test.beforeEach(async ({ page }) => { page.setDefaultTimeout(10000); });
async function read(page, path) {
  const response = await page.request.get(path, { maxRedirects: 0 });
  assertPreview(response);
  expect(response.status(), path).toBe(200);
  return response.json();
}
async function guard(page) {
  expect(process.env.E2E_BASE, 'Explicit isolated preview URL required').toBeTruthy();
  expect(process.env.SMOKE_PASSWORD, 'Explicit isolated preview password required').toBeTruthy();
  const base = new URL(process.env.E2E_BASE);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(base.hostname);
  const response = await page.request.get('/api/admin/health', { maxRedirects: 0 });
  assertPreview(response);
  await signIn(page);
  const providers = await read(page, '/api/providers');
  const knownIds = new Set(['connection-fixture-alpha', 'connection-fixture-beta', 'capacity-fixture-a', 'capacity-fixture-b']);
  expect(providers.connections.every(connection => knownIds.has(connection.id) && connection.name.startsWith('Synthetic'))).toBe(true);
  expect(providers.connections.every(connection => !connection.apiKey && !connection.accessToken && !connection.refreshToken)).toBe(true);
}
async function submit(page, path, method, verb, status = 200) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
  await dialog(page).getByRole('button', { name: verb, exact: true }).click();
  const response = await pending;
  assertPreview(response);
  expect(response.status()).toBe(status);
  return response.json();
}
async function workspaceTask(page, name) {
  await page.getByRole('navigation', { name: 'Keys workspace' }).getByRole('button', { name, exact: true }).click();
}
async function keyTask(surface, name) {
  await surface.getByRole('navigation', { name: 'Key tasks' }).getByRole('button', { name, exact: true }).click();
}
async function keyDetails(page, name = KEY) {
  await workspaceTask(page, 'Client keys');
  const row = page.locator('.keys-row').filter({ has: page.locator('.keys-pick .name', { hasText: name }) });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: `Configure ${name}`, exact: true }).click();
  return page.getByRole('region', { name: 'Selected key configuration', exact: true });
}

test('real isolated key lifecycle and profile versions persist without an upstream call', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await guard(page);
  const created = { profile: null, keys: [] };
  const initialKeys = (await read(page, '/api/keys')).keys;
  expect(initialKeys.some(key => key.name === KEY)).toBe(false);
  expect((await read(page, '/api/access-profiles')).profiles.some(profile => profile.name === PROFILE)).toBe(false);
  try {
    assertPreview(await page.goto('/dashboard/keys'));
    await workspaceTask(page, 'Profiles');
    await page.getByRole('button', { name: 'Create access profile', exact: true }).click();
    await page.locator('.profile-inspector').getByLabel('Profile name', { exact: true }).fill(PROFILE);
    await page.locator('.profile-inspector').getByLabel('Recorded cost ceiling (USD)', { exact: true }).fill('3.25');
    await page.locator('.profile-inspector').getByLabel('Profile model allowlist', { exact: true }).fill('openai/*');
    await page.getByRole('button', { name: 'Review profile', exact: true }).click();
    const profile = await submit(page, '/api/access-profiles', 'POST', 'Save profile', 201);
    created.profile = profile.profile.id;
    await expect(page.getByText('Profile version 1 saved and verified.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create a key', exact: true }).click();
    await page.getByRole('region', { name: 'Create a key', exact: true }).getByLabel('Name', { exact: true }).fill(KEY);
    await page.getByRole('button', { name: 'Review create a key', exact: true }).click();
    const issued = await submit(page, '/api/keys', 'POST', 'Create', 201);
    created.keys.push(issued.id);
    expect(typeof issued.key).toBe('string');
    await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('body')).not.toContainText(issued.key);
    const keyPath = `/api/keys/${issued.id}`;
    let row = await keyDetails(page);
    await row.getByRole('button', { name: 'Reveal key', exact: true }).click();
    const revealed = await submit(page, `${keyPath}/reveal`, 'POST', 'Reveal');
    expect(revealed.key).toBe(issued.key);
    await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('body')).not.toContainText(issued.key);
    await keyTask(row, 'Advanced');
    await row.getByRole('combobox', { name: 'Access profile', exact: true }).selectOption(created.profile);
    await row.getByRole('button', { name: 'Review access profile', exact: true }).click();
    await submit(page, `${keyPath}/profile`, 'POST', 'Apply');
    expect((await read(page, keyPath)).key).toMatchObject({ maxCostUsd: 3.25, allowedModels: ['openai/*'], accessProfileVersion: 1, secretRedacted: true });

    // A competing local edit advances the database after selecting version 1.
    await workspaceTask(page, 'Profiles');
    await page.locator('.profile-row').filter({ hasText: PROFILE }).click();
    const competing = await page.request.put(`/api/access-profiles/${created.profile}`, { data: { expectedVersion: 1, maxCostUsd: 8 } });
    assertPreview(competing);
    expect(competing.status()).toBe(200);
    await page.locator('.profile-inspector').getByLabel('Recorded cost ceiling (USD)', { exact: true }).fill('4.25');
    await page.getByRole('button', { name: 'Review profile', exact: true }).click();
    await submit(page, `/api/access-profiles/${created.profile}`, 'PUT', 'Save profile', 409);
    await expect(dialog(page)).toContainText('This profile changed');
    expect((await read(page, '/api/access-profiles')).profiles.find(value => value.id === created.profile).maxCostUsd).toBe(8);
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.profile-row').filter({ hasText: PROFILE })).toContainText('$8.00');
    await workspaceTask(page, 'Profiles');
    await page.locator('.profile-row').filter({ hasText: PROFILE }).click();
    await page.locator('.profile-inspector').getByLabel('Recorded cost ceiling (USD)', { exact: true }).fill('4.25');
    await page.getByRole('button', { name: 'Review profile', exact: true }).click();
    await submit(page, `/api/access-profiles/${created.profile}`, 'PUT', 'Save profile');
    await expect(page.getByText('Profile version 3 saved and verified.', { exact: true })).toBeVisible();
    expect((await read(page, keyPath)).key.maxCostUsd).toBe(3.25);
    expect((await read(page, '/api/keys')).keys.find(value => value.id === issued.id).profile.behind).toBe(true);

    row = await keyDetails(page);
    await row.getByLabel('Cost ceiling', { exact: true }).fill('2');
    await row.getByRole('button', { name: 'Review key budgets and model access', exact: true }).click();
    await submit(page, keyPath, 'PUT', 'Save');
    expect((await read(page, '/api/keys')).keys.find(value => value.id === issued.id).profile.drifted).toBe(true);
    await keyTask(row, 'Advanced');
    await row.getByLabel('Expiry in UTC', { exact: true }).fill('2030-01-02T03:04:05');
    await row.getByRole('button', { name: 'Review key expiry', exact: true }).click();
    await submit(page, keyPath, 'PUT', 'Save expiry');
    await expect(page.getByText('Expiry saved and verified.', { exact: true })).toBeVisible();
    expect((await read(page, keyPath)).key.expiresAt).toBe('2030-01-02T03:04:05.000Z');

    await keyTask(row, 'Client setup');
    await row.getByRole('button', { name: 'Check configuration', exact: true }).click();
    await expect(row).toContainText('Nothing was contacted.');
    await keyTask(row, 'Advanced');
    await row.getByLabel('Overlap window in hours', { exact: true }).fill('1');
    await row.getByRole('button', { name: 'Review rotate key', exact: true }).click();
    const rotated = await submit(page, `${keyPath}/rotate`, 'POST', 'Rotate', 201);
    created.keys.push(rotated.successor.id);
    await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
    const afterRotation = (await read(page, '/api/keys')).keys;
    expect(afterRotation.find(value => value.id === issued.id).expiresAt).toBe(rotated.overlapEndsAt);
    expect(afterRotation.find(value => value.id === rotated.successor.id).rotation.counterpartKeyId).toBe(issued.id);
    await page.reload();
    expect((await read(page, '/api/keys')).keys.every(value => !Object.hasOwn(value, 'key'))).toBe(true);
    await workspaceTask(page, 'Profiles');
    await page.locator('.profile-row').filter({ hasText: PROFILE }).click();
    await page.getByRole('button', { name: 'Delete access profile', exact: true }).click();
    await submit(page, `/api/access-profiles/${created.profile}`, 'DELETE', 'Delete profile');
    expect((await read(page, '/api/access-profiles')).profiles.some(value => value.id === created.profile)).toBe(false);
    created.profile = null;
    expect((await read(page, keyPath)).key).toMatchObject({ maxCostUsd: 2, accessProfileId: null });
    await testInfo.attach('connections-keys-persistence', { body: JSON.stringify({ fixture: 'connections-keys-v1', profileVersions: [1, 2, 3], keyIds: created.keys, rotationOverlapHours: 1, upstreamCalls: 0, checks: ['profile-create', 'reveal-dismiss', 'adopt', 'stale-refusal', 'edit', 'behind', 'drift', 'expiry', 'local-configuration', 'rotation', 'redacted-reload', 'profile-delete-release'] }, null, 2), contentType: 'application/json' });
  } finally {
    for (const id of created.keys.reverse()) { const response = await page.request.delete(`/api/keys/${id}`); assertPreview(response); expect([200, 404]).toContain(response.status()); }
    if (created.profile) { const response = await page.request.delete(`/api/access-profiles/${created.profile}`); assertPreview(response); expect([200, 404]).toContain(response.status()); }
  }
});

test('synthetic account exclusions and pool bindings persist and restore through the UI', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await guard(page);
  const poolName = `${POOL} ${randomUUID()}`;
  const id = 'connection-fixture-alpha';
  const connectionPath = `/api/providers/${id}`;
  const original = (await read(page, connectionPath)).connection;
  expect(original.isActive).toBe(false);
  const exclusionsPath = `/api/models/disabled?providerAlias=openai&connectionId=${id}`;
  expect((await read(page, exclusionsPath)).ids).toEqual([]);
  expect((await read(page, '/api/settings')).providerStrategies?.['edge-tts'] || {}).toEqual({});
  let poolId;
  try {
    assertPreview(await page.goto(`/dashboard/connections/${id}`));
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await submit(page, connectionPath, 'PUT', 'Enable');
    expect((await read(page, connectionPath)).connection.isActive).toBe(true);
    await page.getByRole('button', { name: 'Disable', exact: true }).click();
    await submit(page, connectionPath, 'PUT', 'Disable');
    expect((await read(page, connectionPath)).connection.isActive).toBe(false);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
    const modelEditor = page.locator('.account-model-access details');
    if ((await modelEditor.getAttribute('open')) === null) await modelEditor.locator('summary').click();
    await expect(modelEditor).toHaveAttribute('open', '');
    await page.getByLabel('Model ID to exclude', { exact: true }).fill('fixture-model');
    await page.getByRole('button', { name: 'Exclude from this account', exact: true }).click();
    await submit(page, '/api/models/disabled', 'POST', 'Apply model policy');
    expect((await read(page, exclusionsPath)).ids).toEqual(['fixture-model']);
    await expect(page.getByText('Account model policy saved and verified.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Allow fixture-model', exact: true }).click();
    await submit(page, '/api/models/disabled', 'DELETE', 'Apply model policy');
    expect((await read(page, exclusionsPath)).ids).toEqual([]);

    await page.goto('/dashboard/network');
    await page.getByRole('button', { name: 'Add a pool', exact: true }).click();
    await dialog(page).getByLabel('Name', { exact: true }).fill(poolName);
    await dialog(page).getByLabel('Proxy URL', { exact: true }).fill('http://127.0.0.1:9');
    const created = await submit(page, '/api/proxy-pools', 'POST', 'Create', 201);
    poolId = created.proxyPool?.id || created.pool?.id || created.id;
    expect(poolId).toBeTruthy();
    await page.goto(`/dashboard/connections/${id}`);
    await page.locator('summary').filter({ hasText: 'Tuning' }).click();
    await page.getByRole('button', { name: 'Proxy pool', exact: true }).click();
    await dialog(page).getByRole('combobox', { name: 'Pool or account proxy', exact: true }).selectOption(poolId);
    await submit(page, connectionPath, 'PUT', 'Save');
    expect((await read(page, connectionPath)).connection.providerSpecificData.proxyPoolId).toBe(poolId);
    await page.reload();
    await expect(page.locator('.facts').first()).toContainText(poolName);
    await page.locator('summary').filter({ hasText: 'Tuning' }).click();
    await page.getByRole('button', { name: 'Proxy pool', exact: true }).click();
    await dialog(page).getByRole('combobox', { name: 'Pool or account proxy', exact: true }).selectOption('');
    await submit(page, connectionPath, 'PUT', 'Save');
    const direct = (await read(page, connectionPath)).connection.providerSpecificData;
    expect(direct.connectionProxyMode === 'direct' || direct.proxyPoolId === '__none__').toBe(true);
    await page.goto('/dashboard/network');
    const strategy = page.locator('section[aria-labelledby="h-strategy"]');
    await strategy.getByRole('combobox', { name: 'Provider id', exact: true }).selectOption('edge-tts');
    await strategy.getByRole('combobox', { name: 'Proxy pool', exact: true }).selectOption(poolId);
    for (const mode of ['none', 'round-robin', 'random']) {
      await strategy.getByRole('combobox', { name: 'Pool selection mode', exact: true }).selectOption(mode);
      await strategy.getByRole('button', { name: 'Save strategy', exact: true }).click();
      await submit(page, '/api/settings', 'PATCH', 'Apply proxy strategy');
      await expect(page.getByText('Virtual-account proxy strategy saved and verified.', { exact: true })).toBeVisible();
      expect((await read(page, '/api/settings')).providerStrategies['edge-tts']).toMatchObject({ proxyPoolId: poolId, rotateStrategy: mode });
    }
    await strategy.getByRole('combobox', { name: 'Pool selection mode', exact: true }).selectOption('none');
    await strategy.getByRole('combobox', { name: 'Proxy pool', exact: true }).selectOption('');
    await strategy.getByRole('button', { name: 'Save strategy', exact: true }).click();
    await submit(page, '/api/settings', 'PATCH', 'Apply proxy strategy');
    await expect(page.getByText('Virtual-account proxy strategy saved and verified.', { exact: true })).toBeVisible();
    expect((await read(page, '/api/settings')).providerStrategies['edge-tts'].proxyPoolId).toBeUndefined();
    const poolRow = page.locator('section[aria-labelledby="h-pools"] .network-pool-row')
      .filter({ has: page.locator('.name').and(page.getByText(poolName, { exact: true })) });
    await expect(poolRow).toHaveCount(1);
    await poolRow.getByRole('button', { name: 'Delete pool', exact: true }).click();
    await submit(page, `/api/proxy-pools/${poolId}`, 'DELETE', 'Delete');
    expect((await read(page, '/api/proxy-pools')).proxyPools.some(pool => pool.id === poolId)).toBe(false);
    poolId = null;
    await testInfo.attach('connections-network-persistence', { body: JSON.stringify({ fixture: 'connections-keys-v1', connectionId: id, localExclusionRestored: true, poolDeleted: true, providerContact: false }), contentType: 'application/json' });
  } finally {
    const unbind = await page.request.put(connectionPath, { data: { proxyPoolId: null, isActive: false } });
    assertPreview(unbind); expect(unbind.status()).toBe(200);
    const enable = await page.request.delete(`${exclusionsPath}&id=fixture-model`); assertPreview(enable); expect(enable.status()).toBe(200);
    const clearStrategy = await page.request.patch('/api/settings', { data: { providerStrategyPatch: { providerId: 'edge-tts', values: { proxyPoolId: null, rotateStrategy: null } } } });
    assertPreview(clearStrategy); expect(clearStrategy.status()).toBe(200);
    if (poolId) { const deletion = await page.request.delete(`/api/proxy-pools/${poolId}`); assertPreview(deletion); expect([200, 404]).toContain(deletion.status()); }
  }
});

test('multi-compatible node endpoints survive create, edit, reload and delete locally', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await guard(page);
  const name = 'Synthetic fixture dual protocol node';
  expect((await read(page, '/api/provider-nodes')).nodes.some(node => node.name.startsWith(name))).toBe(false);
  let nodeId;
  try {
    assertPreview(await page.goto('/dashboard/network'));
    await page.getByRole('button', { name: 'Add a node', exact: true }).click();
    await dialog(page).getByLabel('Name', { exact: true }).fill(name);
    await dialog(page).getByLabel('Prefix', { exact: true }).fill('fixture-dual');
    await dialog(page).getByRole('combobox', { name: 'Type', exact: true }).selectOption('multi-compatible');
    await dialog(page).getByLabel('OpenAI endpoint URL', { exact: true }).fill('http://127.0.0.1:9/v1');
    await dialog(page).getByLabel('Anthropic endpoint URL', { exact: true }).fill('http://127.0.0.1:9/v1');
    await dialog(page).getByLabel('Register the OpenAI Responses transport', { exact: true }).check();
    const created = await submit(page, '/api/provider-nodes', 'POST', 'Create', 201);
    nodeId = created.node.id;
    await expect(page.getByText('Configuration saved and verified.', { exact: true })).toBeVisible();
    const stored = (await read(page, '/api/provider-nodes')).nodes.find(node => node.id === nodeId);
    expect(stored.transports.map(transport => transport.format)).toEqual(['openai', 'claude', 'openai-responses']);
    expect(stored.transports[0].baseUrl).toBe('http://127.0.0.1:9/v1/chat/completions');
    const row = page.locator('.network-node-row').filter({ hasText: name });
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(dialog(page).getByLabel('Anthropic endpoint URL', { exact: true })).toHaveValue('http://127.0.0.1:9/v1/messages');
    await dialog(page).getByLabel('Name', { exact: true }).fill(`${name} edited`);
    await submit(page, `/api/provider-nodes/${nodeId}`, 'PUT', 'Save');
    await expect(page.getByText('Configuration saved and verified.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('.network-node-row').filter({ hasText: `${name} edited` })).toBeVisible();
    await page.locator('.network-node-row').filter({ hasText: `${name} edited` }).getByRole('button', { name: 'Delete node', exact: true }).click();
    await submit(page, `/api/provider-nodes/${nodeId}`, 'DELETE', 'Delete');
    expect((await read(page, '/api/provider-nodes')).nodes.some(node => node.id === nodeId)).toBe(false);
    await testInfo.attach('multi-compatible-node-persistence', { body: JSON.stringify({ fixture: 'connections-keys-v1', nodeId, transports: ['openai', 'claude', 'openai-responses'], deleted: true, upstreamCalls: 0 }), contentType: 'application/json' });
    nodeId = null;
  } finally {
    if (nodeId) { const response = await page.request.delete(`/api/provider-nodes/${nodeId}`); assertPreview(response); expect([200, 404]).toContain(response.status()); }
  }
});
