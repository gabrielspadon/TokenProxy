import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

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
  FREE_TIER_PROVIDERS: { nvidia: {} },
  NO_AUTH_PROVIDER_IDS: [],
  isNoAuthProvider: () => false,
  resolveProviderId: (provider) => provider,
}));
vi.mock('@/sse/utils/logger.js', () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import('../../src/sse/services/auth.js');
const { MAX_RATE_LIMIT_COOLDOWN_MS } = await import('../../open-sse/config/errorConfig.js');

const NOW = new Date('2026-08-31T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function connection(provider, backoffLevel = 0) {
  return { id: `${provider}-a`, provider, name: `${provider}-a`, backoffLevel };
}

function lockedUntil() {
  const update = dbMocks.updateProviderConnection.mock.calls[0][1];
  const key = Object.keys(update).find((k) => k.startsWith('modelLock_'));
  return Date.parse(update[key]) - NOW.getTime();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('per-provider retry-delay cap (#2895)', () => {
  it("caps a free-tier provider's long reset at its real window", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('nvidia')]);

    await markAccountUnavailable(
      'nvidia-a',
      429,
      'Too Many Requests',
      'nvidia',
      'z-ai/glm-5.2',
      NOW.getTime() + 3 * HOUR_MS
    );

    expect(lockedUntil()).toBe(60 * 1000);
  });

  it("caps a free-tier pool's blind backoff so the pool rotates inside that window", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('nvidia', 9)]);

    await markAccountUnavailable('nvidia-a', 429, 'Too Many Requests', 'nvidia', 'z-ai/glm-5.2');

    expect(lockedUntil()).toBe(60 * 1000);
  });

  it("leaves a paid provider's reported reset alone", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('openai')]);

    await markAccountUnavailable(
      'openai-a',
      429,
      'Too Many Requests',
      'openai',
      'gpt-5.1',
      NOW.getTime() + 3 * HOUR_MS
    );

    expect(lockedUntil()).toBe(3 * HOUR_MS);
  });

  it('still clamps a paid provider at the global ceiling', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('openai')]);

    await markAccountUnavailable(
      'openai-a',
      429,
      'Too Many Requests',
      'openai',
      'gpt-5.1',
      NOW.getTime() + 12 * HOUR_MS
    );

    expect(lockedUntil()).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it('leaves a free-tier credential failure on its full lock', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('nvidia')]);

    await markAccountUnavailable('nvidia-a', 401, 'Unauthorized', 'nvidia', 'z-ai/glm-5.2');

    expect(lockedUntil()).toBe(2 * 60 * 1000);
  });

  it("leaves a paid provider's exponential backoff untouched", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('openai', 9)]);

    await markAccountUnavailable('openai-a', 429, 'Too Many Requests', 'openai', 'gpt-5.1');

    expect(lockedUntil()).toBe(5 * 60 * 1000);
  });
});
