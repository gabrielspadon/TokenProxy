import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock('@/lib/localDb', () => dbMocks);
vi.mock('@/lib/network/connectionProxy', () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock('@/shared/constants/providers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  FREE_PROVIDERS: {},
  FREE_TIER_PROVIDERS: {},
  NO_AUTH_PROVIDER_IDS: [],
  isNoAuthProvider: () => false,
  resolveProviderId: (provider) => provider,
}));
vi.mock('@/sse/utils/logger.js', () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { parseUpstreamError } = await import('../../open-sse/utils/error.js');
const { MAX_RATE_LIMIT_COOLDOWN_MS } = await import('../../open-sse/config/errorConfig.js');
const { markAccountUnavailable } = await import('../../src/sse/services/auth.js');

const NOW = new Date('2026-08-31T16:00:00.000Z');

function rateLimited(headers, status = 429) {
  return new Response(JSON.stringify({ error: { message: 'Too Many Requests' } }), {
    status,
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('per-key rate-limit window from reset headers (#3203)', () => {
  it.each([
    ['seconds duration', { 'x-ratelimit-reset-requests': '20s' }, 20 * 1000],
    ['compound duration', { 'x-ratelimit-reset-requests': '1m30s' }, 90 * 1000],
    ['sub-second duration', { 'x-ratelimit-reset-requests': '500ms' }, 500],
    ['generic reset header', { 'x-ratelimit-reset': '45' }, 45 * 1000],
  ])('reads the request window from a %s', async (_label, headers, expectedMs) => {
    const parsed = await parseUpstreamError(rateLimited(headers));

    expect(parsed.resetsAtMs).toBe(NOW.getTime() + expectedMs);
  });

  it('reads an absolute RFC3339 reset', async () => {
    const reset = '2026-08-31T16:00:30.000Z';

    const parsed = await parseUpstreamError(rateLimited({ 'x-ratelimit-reset-requests': reset }));

    expect(parsed.resetsAtMs).toBe(Date.parse(reset));
  });

  it('keeps Retry-After ahead of the reset headers', async () => {
    const parsed = await parseUpstreamError(
      rateLimited({
        'retry-after': '5',
        'x-ratelimit-reset-requests': '20s',
      })
    );

    expect(parsed.resetsAtMs).toBe(NOW.getTime() + 5000);
  });

  it('prefers the request window over the shared reset header', async () => {
    const parsed = await parseUpstreamError(
      rateLimited({
        'x-ratelimit-reset-requests': '20s',
        'x-ratelimit-reset': '3600',
      })
    );

    expect(parsed.resetsAtMs).toBe(NOW.getTime() + 20 * 1000);
  });

  it('bounds a window the provider reports as absurdly long', async () => {
    const parsed = await parseUpstreamError(rateLimited({ 'x-ratelimit-reset-requests': '9999h' }));

    expect(parsed.resetsAtMs).toBe(NOW.getTime() + MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it.each([
    ['empty', { 'x-ratelimit-reset-requests': '' }],
    ['prose', { 'x-ratelimit-reset-requests': 'soon' }],
    ['zero duration', { 'x-ratelimit-reset-requests': '0s' }],
    ['spaced duration', { 'x-ratelimit-reset-requests': '20 s' }],
    ['past timestamp', { 'x-ratelimit-reset-requests': '2026-08-31T15:59:00.000Z' }],
    ['bare epoch seconds', { 'x-ratelimit-reset': '1788969600' }],
  ])('rejects a %s reset value', async (_label, headers) => {
    const parsed = await parseUpstreamError(rateLimited(headers));

    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it('ignores the headers on a status that is not a rate limit', async () => {
    const parsed = await parseUpstreamError(
      rateLimited({ 'x-ratelimit-reset-requests': '20s' }, 500)
    );

    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it('benches the account for exactly the window the provider named', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { id: 'nim-a', provider: 'nvidia', name: 'nim-a', backoffLevel: 6 },
    ]);
    const parsed = await parseUpstreamError(rateLimited({ 'x-ratelimit-reset-requests': '20s' }));

    await markAccountUnavailable(
      'nim-a',
      429,
      'Too Many Requests',
      'nvidia',
      'z-ai/glm-5.2',
      parsed.resetsAtMs
    );

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update['modelLock_z-ai/glm-5.2']).toBe(
      new Date(NOW.getTime() + 20 * 1000).toISOString()
    );
    expect(update.backoffLevel).toBe(0);
  });
});
