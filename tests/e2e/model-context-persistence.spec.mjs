import { test, expect } from 'playwright/test';
import { signIn } from './helpers.mjs';
import { credentiallessDatabase } from './capacity-economics-fixture-guard.mjs';

// Real isolated requests only. Configuration writes go through the editor and
// its confirmation; API reads verify them without replacing browser responses.
const ENDPOINT = '/api/model-context';
const PREVIEW_HEADER = 'x-tokenproxy-preview-kind';
const PREVIEW_KIND = 'synthetic-fixture';
const WINDOW = 900000;
const identity = model => `${model.provider}/${model.model}`;
const entryFor = (page, key) => page.locator('article[data-account-id]').filter({ hasText: key });
const tokensIn = locator => locator.locator('[data-context-token-input]');
const detail = page => page.locator('[id^="context-detail-"]');
const toast = page => page.locator('[class*="Notification-root"]');
const fact = (page, label) => detail(page).locator('.model-context-facts > div').filter({ hasText: label }).locator('dd');

function assertSynthetic(response) {
  expect(response, 'The isolated preview must return a response').not.toBeNull();
  expect(response.headers()[PREVIEW_HEADER], 'Refusing changes outside the synthetic fixture preview').toBe(PREVIEW_KIND);
}

async function readJson(page, resource) {
  const response = await page.request.get(resource, { maxRedirects: 0 });
  assertSynthetic(response);
  expect(response.status(), `Read failed for ${resource}`).toBe(200);
  return response.json();
}

// The board is the surface: search narrows to the entry, the entry carries its
// own window field, and expanding it shows the precedence evidence in place.
async function selectModel(page, key, { reload = false } = {}) {
  const response = reload ? await page.reload() : await page.goto('/dashboard/model-context');
  assertSynthetic(response);
  await expect(page.getByRole('heading', { name: 'Context limits', exact: true })).toBeVisible();
  await page.getByLabel('Find a model or saved key', { exact: true }).fill(key);
  const entry = entryFor(page, key);
  await expect(entry).toHaveCount(1);
  if (await detail(page).count() === 0) await entry.locator('button[aria-label^="Expand "]').first().click();
  await expect(detail(page)).toBeVisible();
  await detail(page).getByLabel('Override scope and saved key', { exact: true }).selectOption(key);
  return entry;
}

async function mutateThroughUi(page, method, key, action) {
  const pending = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === ENDPOINT && response.request().method() === method
      && (method !== 'DELETE' || url.searchParams.get('key') === key);
  });
  await action();
  const response = await pending;
  assertSynthetic(response);
  const body = await response.json();
  // Keep only configuration evidence, never authentication headers or cookies.
  return { status: response.status(), success: body.success, overrides: body.overrides };
}

function modelReadback(body, key) {
  const row = body.models.find(model => identity(model) === key);
  expect(row, 'The selected catalog identity must survive each refresh').toBeTruthy();
  return { overrides: body.overrides, staticContextWindow: row.staticContextWindow, contextWindow: row.contextWindow };
}

test('synthetic UI persists an exact model window and removes it back to the original map', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  expect(process.env.E2E_BASE, 'Set E2E_BASE explicitly for this mutation test').toBeTruthy();
  expect(process.env.SMOKE_PASSWORD, 'Supply the isolated preview password explicitly').toBeTruthy();
  const base = new URL(process.env.E2E_BASE);
  expect(['127.0.0.1', 'localhost', '[::1]'], 'Persistence is loopback-only').toContain(base.hostname);
  expect(['http:', 'https:']).toContain(base.protocol);
  expect(base.username || base.password, 'Do not put credentials in E2E_BASE').toBe('');
  const gate = await page.request.get(new URL('/api/admin/health', base).href, { maxRedirects: 0 });
  assertSynthetic(gate); // Check before transmitting the supplied password.
  const database = credentiallessDatabase();
  let fixtureAccounts;
  try {
    fixtureAccounts = database.prepare('SELECT id, provider FROM providerConnections ORDER BY id').all();
  } finally { database.close(); }
  await signIn(page);
  const providers = await readJson(page, '/api/providers');
  expect(providers.connections.map(({ id, provider }) => ({ id, provider })).sort((a, b) => a.id.localeCompare(b.id)),
    'The preview must expose exactly the verified credentialless fixture accounts').toEqual(fixtureAccounts);
  const initial = await readJson(page, ENDPOINT);
  expect(initial.inventory).toMatchObject({ source: 'local', dynamicCatalogs: false });
  expect(Array.isArray(initial.models)).toBe(true);
  expect(initial.overrides && typeof initial.overrides === 'object' && !Array.isArray(initial.overrides)).toBe(true);
  const eligible = initial.models.filter(model => typeof model.provider === 'string' && model.provider.trim()
    && typeof model.model === 'string' && model.model.trim()
    && Number.isSafeInteger(model.staticContextWindow) && model.staticContextWindow > 1);
  const chosen = eligible.find(model => identity(model) === 'alicode-intl/qwen3.5-plus') || eligible[0];
  expect(chosen, 'The local catalog needs a model with a known static window greater than one token').toBeTruthy();
  const key = identity(chosen);
  expect(Object.hasOwn(initial.overrides, key), `Refusing to overwrite the existing exact key ${key}`).toBe(false);
  expect(chosen.contextWindow, 'The fixed test value must differ from the initial effective window').not.toBe(WINDOW);
  const originalOverrides = structuredClone(initial.overrides);
  const expectedOverrides = { ...originalOverrides, [key]: WINDOW };
  const evidence = {
    kind: PREVIEW_KIND,
    key,
    requestedContextWindow: WINDOW,
    initial: modelReadback(initial, key),
    put: null,
    readback: null,
    afterReload: null,
    delete: null,
    restored: null,
  };
  const writes = [];
  const forbiddenRequests = [];
  const observe = request => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:')
      && (url.origin !== base.origin || /^\/v1\//.test(url.pathname) || /^\/api\/pxpipe\/(health|start|stop|restart|install)$/.test(url.pathname))) {
      forbiddenRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    }
    if (url.pathname === ENDPOINT && ['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method())) {
      writes.push({ method: request.method(), key: url.searchParams.get('key'), body: request.method() === 'PUT' ? request.postDataJSON() : null });
    }
  };
  page.on('request', observe);
  let saveConfirmed = false;
  let deleteAttempted = false;

  async function removeThroughUi() {
    const entry = entryFor(page, key);
    await entry.locator('[aria-label^="Remove the override for "]').first().click();
    const pair = entry.getByRole('group', { name: /^Confirm: Remove the override for / });
    await expect(pair).toBeVisible();
    deleteAttempted = true;
    evidence.delete = await mutateThroughUi(page, 'DELETE', key, () => pair.getByRole('button', { name: 'Remove', exact: true }).click());
    expect(evidence.delete).toEqual({ status: 200, success: true, overrides: originalOverrides });
    await expect(toast(page)).toContainText(`Override removed and verified after refresh: ${key}.`);
    evidence.restored = modelReadback(await readJson(page, ENDPOINT), key);
    expect(evidence.restored).toEqual(evidence.initial);
    expect(Object.entries(evidence.restored.overrides), 'Preserve wildcard precedence in the original map order').toEqual(Object.entries(originalOverrides));
  }

  try {
    const entry = await selectModel(page, key);
    await tokensIn(entry).fill(String(WINDOW));
    expect(writes, 'Typing a window must not write configuration').toEqual([]);
    expect((await readJson(page, ENDPOINT)).overrides).toEqual(originalOverrides);

    evidence.put = await mutateThroughUi(page, 'PUT', key, () => tokensIn(entry).press('Enter'));
    saveConfirmed = evidence.put.status === 200 && evidence.put.success === true && evidence.put.overrides?.[key] === WINDOW;
    expect(evidence.put).toEqual({ status: 200, success: true, overrides: expectedOverrides });
    await expect(toast(page)).toContainText(`Override saved and verified after refresh: ${key}.`);
    evidence.readback = modelReadback(await readJson(page, ENDPOINT), key);
    expect(evidence.readback).toEqual({ overrides: expectedOverrides, staticContextWindow: chosen.staticContextWindow, contextWindow: WINDOW });
    await expect(fact(page, 'Effective window')).toHaveText('900,000 tokens');

    await selectModel(page, key, { reload: true });
    await expect(detail(page).getByLabel('Override scope and saved key', { exact: true })).toHaveValue(key);
    await expect(tokensIn(entryFor(page, key))).toHaveValue(String(WINDOW));
    await expect(fact(page, 'Winning override key')).toHaveText(key);
    evidence.afterReload = modelReadback(await readJson(page, ENDPOINT), key);
    expect(evidence.afterReload).toEqual(evidence.readback);

    await removeThroughUi();
    await selectModel(page, key, { reload: true });
    await expect(entryFor(page, key).locator('[aria-label^="Remove the override for "]')).toHaveCount(0);
    expect(modelReadback(await readJson(page, ENDPOINT), key)).toEqual(evidence.initial);
    expect(writes).toEqual([
      { method: 'PUT', key: null, body: { key, contextWindow: WINDOW } },
      { method: 'DELETE', key, body: null },
    ]);
    expect(forbiddenRequests, 'No provider, service-action or cross-origin request is permitted').toEqual([]);
  } finally {
    try {
      // A later assertion failure still removes a confirmed test-owned value.
      // Do not replay an uncertain DELETE or remove a concurrently changed key.
      if (saveConfirmed && !deleteAttempted) {
        const current = await readJson(page, ENDPOINT);
        expect(current.overrides[key], 'Refusing cleanup of a concurrently changed override').toBe(WINDOW);
        await selectModel(page, key);
        await removeThroughUi();
      }
    } finally {
      page.off('request', observe);
      await testInfo.attach('model-context-persistence-receipt.json', {
        contentType: 'application/json',
        body: JSON.stringify({ ...evidence, writes, forbiddenRequests }, null, 2),
      });
    }
  }
});
