/**
 * A 429 whose `retry-after` names a QUOTA WINDOW RESET must not bench an
 * account our own evidence says still has headroom.
 *
 * Live production, 2026-09-06: Anthropic answered a burst with retry-after
 * 515919s (143h, exactly connection 7a1acb09's `weekly (7d)` reset) and 17052s
 * (4.7h, exactly df0afad0's `session (5h)` reset). auth.js wrote each verbatim
 * into `modelLock_<model>`, clamped only at the 6h provider ceiling, so
 * `isModelLockActive` dropped those lanes from `availableConnections` BEFORE
 * ranking ran. df0afad0 was reading 63% session / 68% weekly and had served
 * claude-opus-5 thirty seconds earlier. With enough lanes benched, the accounts
 * still in the pool were the genuinely exhausted ones, so rankAccounts answered
 * `all-depleted` and the caller got
 * `No account available (no-eligible-account:all-depleted)`.
 *
 * Mocked end to end: no provider call, no live DB, no quota spent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

const windowMocks = vi.hoisted(() => ({
  getWindows: vi.fn(),
  putWindows: vi.fn(async () => 0),
}));

vi.mock('@/lib/localDb', () => dbMocks);
vi.mock('@/lib/db/repos/quotaWindowsRepo.js', () => windowMocks);
vi.mock('@/lib/network/connectionProxy', () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock('@/shared/constants/providers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  FREE_PROVIDERS: {},
  FREE_TIER_PROVIDERS: {},
  NO_AUTH_PROVIDER_IDS: [],
  resolveProviderId: (provider) => provider,
  isNoAuthProvider: () => false,
  isProviderDisabled: () => false,
}));
vi.mock('@/sse/services/quotaGuard.js', () => ({
  evaluateQuota: vi.fn(async () => ({ paused: false })),
}));
vi.mock('@/sse/utils/logger.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { getModelLockKey } = await import('../../open-sse/services/accountFallback.js');
const { markAccountUnavailable } = await import('../../src/sse/services/auth.js');

const MODEL = 'claude-fable-5';
const NOW = new Date('2026-09-06T11:35:47.000Z');
const CONN = 'df0afad0';

// The two live shapes, verbatim from the production quotaWindows rows.
const SESSION_RESET = '2026-09-06T16:20:00.507Z';
const WEEKLY_RESET = '2026-09-12T09:59:59.948Z';

const win = (scope, remaining, resetAt) => ({
  scope,
  remaining,
  limit: 100,
  resetAt,
  observedAt: new Date(NOW.getTime() - 60_000).toISOString(),
  confidence: 'unknown',
});

const lockMs = () => {
  const write = dbMocks.updateProviderConnection.mock.calls[0][1];
  return new Date(write[getModelLockKey(MODEL)]).getTime() - NOW.getTime();
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbMocks.getSettings.mockResolvedValue({});
  dbMocks.getProxyPools.mockResolvedValue([]);
  dbMocks.updateProviderConnection.mockResolvedValue(undefined);
  dbMocks.getProviderConnections.mockResolvedValue([
    { id: CONN, provider: 'claude', backoffLevel: 0 },
  ]);
});

describe('429 retry-after naming a window reset', () => {
  it('caps the model lock at a minute when our own windows still show headroom', async () => {
    windowMocks.getWindows.mockResolvedValue([
      win('session (5h)', 63, SESSION_RESET),
      win('weekly (7d)', 68, WEEKLY_RESET),
    ]);

    // The live 17052s (4.7h) reset df0afad0 was benched with.
    const { shouldFallback } = await markAccountUnavailable(
      CONN,
      429,
      'rate limit',
      'claude',
      MODEL,
      NOW.getTime() + 17052 * 1000
    );

    expect(shouldFallback).toBe(true);
    expect(lockMs()).toBe(60_000);
  });

  it('caps a 143h weekly-reset retry-after the same way', async () => {
    windowMocks.getWindows.mockResolvedValue([
      win('session (5h)', 10, SESSION_RESET),
      win('weekly (7d)', 17, WEEKLY_RESET),
    ]);

    await markAccountUnavailable(
      CONN,
      429,
      'rate limit',
      'claude',
      MODEL,
      NOW.getTime() + 515919 * 1000
    );

    expect(lockMs()).toBe(60_000);
  });

  it('honours the provider reset when a general window is genuinely at zero', async () => {
    windowMocks.getWindows.mockResolvedValue([
      win('session (5h)', 0, SESSION_RESET),
      win('weekly (7d)', 40, WEEKLY_RESET),
    ]);

    await markAccountUnavailable(
      CONN,
      429,
      'rate limit',
      'claude',
      MODEL,
      NOW.getTime() + 17052 * 1000
    );

    // 4.7h is under the 6h ceiling, so the provider's own number stands.
    expect(lockMs()).toBe(17052 * 1000);
  });

  // Absence of evidence must never be read as headroom, in either direction:
  // with nothing readable the provider's reset is the only fact anyone has.
  it('honours the provider reset when no window evidence is readable', async () => {
    windowMocks.getWindows.mockResolvedValue([]);

    await markAccountUnavailable(
      CONN,
      429,
      'rate limit',
      'claude',
      MODEL,
      NOW.getTime() + 17052 * 1000
    );

    expect(lockMs()).toBe(17052 * 1000);
  });

  it('honours the provider reset when the window read throws', async () => {
    windowMocks.getWindows.mockRejectedValue(new Error('db closed'));

    await markAccountUnavailable(
      CONN,
      429,
      'rate limit',
      'claude',
      MODEL,
      NOW.getTime() + 17052 * 1000
    );

    expect(lockMs()).toBe(17052 * 1000);
  });

  // A 401/403/404 is about the credential, not a window, so headroom says
  // nothing about it and the existing cooldown must be untouched.
  it('leaves a non-429 lock alone even with headroom on record', async () => {
    windowMocks.getWindows.mockResolvedValue([win('session (5h)', 63, SESSION_RESET)]);

    await markAccountUnavailable(
      CONN,
      403,
      'forbidden',
      'claude',
      MODEL,
      NOW.getTime() + 17052 * 1000
    );

    expect(lockMs()).toBe(17052 * 1000);
  });

  // The whole point of the ceiling is that the lane comes BACK. A lock longer
  // than the pool's own selection horizon is what produced all-depleted.
  it('never benches a headroom account past the six-hour provider ceiling', async () => {
    windowMocks.getWindows.mockResolvedValue([win('weekly (7d)', 28, WEEKLY_RESET)]);

    await markAccountUnavailable(
      CONN,
      429,
      'rate limit',
      'claude',
      MODEL,
      NOW.getTime() + 515355 * 1000
    );

    expect(lockMs()).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });
});

describe('quota and temporary failure classification', () => {
  it('honors a verified weekly depletion beyond the generic six-hour ceiling', async () => {
    windowMocks.getWindows.mockResolvedValue([win('weekly (7d)', 90, WEEKLY_RESET)]);
    const result = await markAccountUnavailable(CONN, 429, '{"error":{"code":"usage_limit_reached"}}', 'claude', MODEL, NOW.getTime() + 143 * 3600_000);
    expect(result).toMatchObject({ failureClass: 'quota', mustWait: false, retrySameAccount: false });
    expect(lockMs()).toBe(143 * 3600_000);
  });
  // mustWait is gone. Replay safety is NOT: `isReplaySafeRejection` still gates
  // whether a possibly-billed generation may be re-dispatched, so this only
  // asserts that a rate limit no longer refuses the pool on its own.
  it('rotates on a temporary rate limit instead of making the caller wait', async () => {
    windowMocks.getWindows.mockResolvedValue([win('weekly (7d)', 90, WEEKLY_RESET)]);
    const result = await markAccountUnavailable(CONN, 429, 'rate limit', 'claude', MODEL);
    expect(result).toMatchObject({ failureClass: 'rate', mustWait: false, retrySameAccount: false });
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
  // The no-replay guard for an uncertain generation lives in
  // `isReplaySafeRejection`, which reads the wire permission: 503 is not in
  // REJECTED_STATUSES and carries no `x-tokenproxy-replay-safe: true`, so
  // chat.js still refuses to re-dispatch it. Classification alone must not be
  // the thing that refuses, which is what `mustWait: true` used to do.
  it('marks 503 as temporary without guessing that generation is safe to replay', async () => {
    const result = await markAccountUnavailable(CONN, 503, 'overloaded', 'claude', MODEL);
    expect(result).toMatchObject({ failureClass: 'transient', mustWait: false, retrySameAccount: false });
  });
});
