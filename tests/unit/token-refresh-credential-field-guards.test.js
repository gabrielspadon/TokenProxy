// Kills updateProviderCredentials' field-guard ConditionalExpression survivors:
// each field write is proven both when present (already covered elsewhere)
// and when absent, since a mutant flipping "if (x)" to "if (true)" only shows
// up when x is falsy and the field must NOT be written.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/sse/utils/logger.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

const getProviderConnectionById = vi.fn();
const updateProviderConnection = vi.fn();
vi.mock('../../src/lib/localDb.js', () => ({
  getProviderConnectionById: (...a) => getProviderConnectionById(...a),
  updateProviderConnection: (...a) => updateProviderConnection(...a),
}));

const mod = await import('@/sse/services/tokenRefresh.js');

beforeEach(() => {
  getProviderConnectionById.mockReset();
  updateProviderConnection.mockReset();
  updateProviderConnection.mockResolvedValue({ id: 'c' });
});

it('no accessToken in the input means no accessToken key in the write', async () => {
  await mod.updateProviderCredentials('c', { idToken: 'x' });
  const [, updates] = updateProviderConnection.mock.calls[0];
  expect(updates).not.toHaveProperty('accessToken');
});

it('no idToken in the input means no idToken key in the write', async () => {
  await mod.updateProviderCredentials('c', { accessToken: 'a' });
  const [, updates] = updateProviderConnection.mock.calls[0];
  expect(updates).not.toHaveProperty('idToken');
});

it('no lastRefreshAt in the input means no lastRefreshAt key in the write', async () => {
  await mod.updateProviderCredentials('c', { accessToken: 'a' });
  const [, updates] = updateProviderConnection.mock.calls[0];
  expect(updates).not.toHaveProperty('lastRefreshAt');
});

it('neither expiresIn nor expiresAt present writes no expiresAt/expiresIn keys', async () => {
  await mod.updateProviderCredentials('c', { accessToken: 'a' });
  const [, updates] = updateProviderConnection.mock.calls[0];
  expect(updates).not.toHaveProperty('expiresAt');
  expect(updates).not.toHaveProperty('expiresIn');
});

it('expiresAt (no expiresIn) takes the else-if branch and computes expiresIn from the clock', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  await mod.updateProviderCredentials('c', { accessToken: 'a', expiresAt: future });
  const [, updates] = updateProviderConnection.mock.calls[0];
  expect(updates.expiresAt).toBe(future);
  expect(updates.expiresIn).toBeGreaterThan(0);
});
