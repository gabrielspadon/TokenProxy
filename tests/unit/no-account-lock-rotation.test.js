/**
 * There is no account lock. A failure moves the request to the next account
 * and the failed one stays in the pool.
 *
 * Live production, 2026-09-11: twelve `modelLock_claude-opus-5` writes in one
 * hour landed on the only two seats with headroom, seven minutes each. Thirteen
 * seconds after each write the next request read `SEL refused why="none-eligible"`
 * and the caller was answered `Empty response content ... (reset after 6m 51s)`
 * while both accounts were healthy. Three separate mechanisms produced that:
 *
 *   1. `accountAdmissionReason` dropped a locked account from the candidate set,
 *      so enough locks emptied the pool outright.
 *   2. `temporaryPinWait` turned a pinned session's lock into `mustWait: true`,
 *      which returns the error instead of rotating.
 *   3. `markAccountUnavailable` set `mustWait` for every `rate` and `transient`
 *      class, which does the same thing for every request, pinned or not.
 *
 * All three are gone. What replaces them is a WALL-CLOCK bound on rotation, so
 * the request walks the pool instead of parking, but never walks it forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));
vi.mock('@/lib/localDb', () => dbMocks);
vi.mock('@/lib/db/repos/quotaWindowsRepo.js', () => ({
  getWindows: vi.fn(async () => []),
  putWindows: vi.fn(async () => 0),
}));
vi.mock('@/lib/network/connectionProxy', () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock('@/sse/services/quotaGuard.js', () => ({ evaluateQuota: vi.fn(async () => ({ paused: false })) }));
vi.mock('@/sse/utils/logger.js', () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { getModelLockKey } = await import('../../open-sse/services/accountFallback.js');
const admission = await import('../../src/sse/services/accountAdmissionPolicy.js');
const { markAccountUnavailable } = await import('../../src/sse/services/auth.js');

const MODEL = 'claude-opus-5';
const NOW = Date.parse('2026-09-11T17:52:00.000Z');
const HOUR = 3600_000;

const locked = (extra = {}) => ({
  id: 'cfa65b96', provider: 'claude', authType: 'oauth', accessToken: 'x',
  [getModelLockKey(MODEL)]: new Date(NOW + HOUR).toISOString(),
  ...extra,
});

describe('a timed lock never removes an account from selection', () => {
  it('admits an account whose model lock is active for another hour', () => {
    expect(admission.accountAdmissionReason(locked(), { model: MODEL, now: NOW })).toBeNull();
  });

  it('admits an account under the account-wide lock too', () => {
    const all = { id: 'c2c636a6', provider: 'claude', authType: 'oauth', accessToken: 'x',
      [getModelLockKey(null)]: new Date(NOW + 6 * HOUR).toISOString() };
    expect(admission.accountAdmissionReason(all, { model: MODEL, now: NOW })).toBeNull();
  });

  it('still excludes on the PROVIDER\'s own exhausted window, which is not our lock', () => {
    const spent = { id: 'ag1', provider: 'antigravity', authType: 'oauth', accessToken: 'x',
      lastQuotaSnapshot: { windows: [{ key: MODEL, remainingPercentage: 0, resetAt: new Date(NOW + HOUR).toISOString() }] } };
    expect(admission.accountAdmissionReason(spent, { model: MODEL, now: NOW })).toBe('quota-exhausted');
  });

  it('exports no temporaryPinWait: a pinned session cannot be parked on a cooldown', () => {
    expect(admission.temporaryPinWait).toBeUndefined();
  });
});

describe('markAccountUnavailable never tells the caller to wait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getSettings.mockResolvedValue({});
    dbMocks.getProxyPools.mockResolvedValue([]);
    dbMocks.updateProviderConnection.mockResolvedValue(undefined);
    dbMocks.getProviderConnections.mockResolvedValue([{ id: 'cfa65b96', provider: 'claude', backoffLevel: 0 }]);
  });

  it.each([
    [429, 'rate limit exceeded'],
    [500, 'internal error'],
    [502, 'bad gateway'],
    [529, 'overloaded'],
  ])('%i returns shouldFallback with mustWait false', async (status, text) => {
    const result = await markAccountUnavailable('cfa65b96', status, text, 'claude', MODEL);
    expect(result.shouldFallback).toBe(true);
    expect(result.mustWait).toBe(false);
  });
});

// Source-level guards. The behavioural cases above prove today's tree is right;
// these name the three specific edits that would quietly put the bench back,
// each of which passed review once already.
describe('the bench cannot be reintroduced', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('admission does not consult a timed lock', () => {
    const policy = read('../../src/sse/services/accountAdmissionPolicy.js');
    expect(policy).not.toContain('isModelLockActive');
    expect(policy).not.toContain('getActiveModelFailure');
    expect(policy).toContain('getExhaustedQuotaWindow');
  });

  it('selection carries no model-locked verdict to emit', () => {
    const auth = read('../../src/sse/services/auth.js');
    expect(auth).not.toContain("'model-locked'");
    expect(auth).not.toContain('temporaryPinWait');
    // The enum is the other half: an emission with no verdict would throw, so
    // removing it here is what keeps the line from coming back by accident.
    expect(read('../../src/shared/observability/decide.js')).not.toContain("'model-locked'");
  });

  it('markAccountUnavailable does not derive mustWait from the failure class', () => {
    const auth = read('../../src/sse/services/auth.js');
    expect(auth).not.toMatch(/mustWait:\s*lockClass/);
    expect(auth).toContain('retrySameAccount: false, mustWait: false,');
  });
});

describe('rotation is bounded by wall clock, not by benching accounts', () => {
  const chat = readFileSync(fileURLToPath(new URL('../../src/sse/handlers/chat.js', import.meta.url)), 'utf8');

  it('declares a rotation time budget', () => {
    expect(chat).toContain('const fallbackDeadline = getRequestFallbackDeadline(request);');
    const deadline = readFileSync(new URL('../../open-sse/utils/fallbackDeadline.js', import.meta.url), 'utf8');
    expect(deadline).toContain('timeoutMs = FALLBACK_BUDGET_MS');
    expect(deadline).toContain('now = () => performance.now()');
  });

  it('stops rotating once the budget is spent, on the failover path', () => {
    const ceilingAt = chat.indexOf('if (maxAttempts && excludeConnectionIds.size + 1 >= maxAttempts)');
    const retryAt = chat.indexOf('if (retrySameAccount === true');
    expect(ceilingAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(ceilingAt);
    expect(chat.slice(ceilingAt, retryAt)).toContain('fallbackDeadline.throwIfExpired(callerSignal);');
  });

  it('no longer bypasses a lock for the just-failed account, because none binds', () => {
    expect(chat).not.toContain('ignoreModelLockConnId');
  });
});
