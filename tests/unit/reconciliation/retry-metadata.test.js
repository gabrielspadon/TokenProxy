// G4 — retry metadata truth.
//
// RECONCILIATION.md P1 "Retry and backpressure truth" and overlay-spec.md §4.
// Three claims, each falsifiable:
//
//   1. A refusal that CAN be retried says when, from real state. A constant is a
//      guess that is wrong for every caller but one, and the floor of 1 exists
//      because `Retry-After: 0` reads as "retry now" and turns a cooldown into a
//      hot loop.
//   2. A refusal that CANNOT be retried says nothing about waiting. 401, 402 and
//      a policy rejection are terminal: a Retry-After there advertises a window
//      that will never open, and the caller burns its budget discovering that.
//   3. A LOCAL admission refusal is not a claim about the provider. `failure_phase`
//      is the field that keeps "TokenProxy's own gate said no" distinguishable
//      from "the upstream rejected it", which is the distinction a caller doing
//      its own backoff math actually needs.
//
// The classifier and the header builder are tested directly rather than only
// through the handler: they are the single point every one of the repo's local
// refusals routes through, so a regression there is a regression everywhere at
// once.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errorResponse,
  unavailableResponse,
  isRetryableStatus,
  retryAfterSeconds,
  NEVER_RETRY_STATUSES,
} from 'open-sse/utils/error.js';
import { checkFallbackError } from 'open-sse/services/accountFallback.js';

// ---------------------------------------------------------------------------
// Handler-level mocks. Same shape as the sibling chat handler suites: the real
// module graph reaches the DB, and this gate is about the response, not the DB.
// ---------------------------------------------------------------------------
const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const dispatchMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock('@/sse/services/auth.js', () => ({
  clearAccountError: authMocks.clearAccountError,
  extractApiKey: () => null,
  getProviderCredentials: authMocks.getProviderCredentials,
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: authMocks.markAccountUnavailable,
}));
vi.mock('open-sse/handlers/chatCore.js', () => dispatchMocks);
vi.mock('open-sse/services/combo.js', async (importOriginal) => ({
  ...(await importOriginal()),
  detectRequiredCapabilities: vi.fn(() => []),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));
vi.mock('@/sse/services/model.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...modelMocks,
}));
vi.mock('@/lib/localDb', () => settingsMocks);
vi.mock('@/sse/services/tokenRefresh.js', () => ({
  checkAndRefreshToken: vi.fn(async (_provider, creds) => creds),
  updateProviderCredentials: vi.fn(),
}));
vi.mock('@/sse/utils/logger.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(() => '***'),
  warn: vi.fn(),
}));
vi.mock('open-sse/utils/ollamaTransform.js', () => ({ transformToOllama: (response) => response }));

let handleChat;
let __rateLimiter;

// Synthetic, obviously fake, and never read from the environment.
function account(connectionId = 'account-a') {
  return {
    connectionId,
    connectionName: connectionId,
    apiKey: 'sk-fake-not-a-real-key',
    providerSpecificData: {},
  };
}

function request() {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'codex/gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
}

function failure(status, error) {
  return {
    success: false,
    status,
    error,
    response: Response.json({ error: { message: error } }, { status }),
  };
}

function success() {
  return {
    success: true,
    response: Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  };
}

const retryAfter = (response) => response.headers.get('retry-after');

beforeAll(async () => {
  ({ handleChat, __rateLimiter } = await import('@/sse/handlers/chat.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  __rateLimiter.reset();
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: false,
    providerThinking: {},
    providerStrategies: {},
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: 'codex', model: 'gpt-5.6-sol' });
  authMocks.getProviderCredentials.mockResolvedValue(account('account-a'));
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 1 });
});

describe('G4 — Retry-After comes from real state, never a constant', () => {
  it("derives the wait from a quota window's own reset instant", () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    // Same helper, three different real windows, three different answers. A
    // constant would return one number for all of them.
    expect(retryAfterSeconds({ at: now + 30_000 }, now)).toBe(30);
    expect(retryAfterSeconds({ at: new Date(now + 90_000) }, now)).toBe(90);
    expect(retryAfterSeconds({ at: new Date(now + 5 * 60_000).toISOString() }, now)).toBe(300);
  });

  it('floors at 1 second and never reports 0, even for a window already past', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterSeconds({ at: now - 60_000 }, now)).toBe(1);
    expect(retryAfterSeconds({ ms: 0 }, now)).toBe(1);
    expect(retryAfterSeconds({ ms: 200 }, now)).toBe(1);
  });

  it('emits NO header when there is no real state to derive one from', () => {
    // Silence is the honest answer here. Emitting a default would be the exact
    // "guessed constant" the gate forbids.
    expect(retryAfterSeconds({})).toBeNull();
    expect(retryAfterSeconds({ at: null, ms: null })).toBeNull();
    expect(retryAfterSeconds({ at: 'not a date' })).toBeNull();
    expect(retryAfter(errorResponse(503, 'no idea when'))).toBeNull();
  });

  it('rounds UP, so a client waking on the hint finds the window actually open', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterSeconds({ ms: 1001 }, now)).toBe(2);
    expect(retryAfterSeconds({ ms: 29_500 }, now)).toBe(30);
  });
});

describe('G4 — auth, payment and policy are NEVER retried', () => {
  it('classifies the terminal statuses as non-retryable, and the transient ones as retryable', () => {
    for (const status of [400, 401, 402, 403, 413, 422]) {
      expect(isRetryableStatus(status), `status ${status}`).toBe(false);
      expect(NEVER_RETRY_STATUSES.has(status)).toBe(true);
    }
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status), `status ${status}`).toBe(true);
    }
  });

  it('strips Retry-After from a terminal status even when a real reset instant is supplied', () => {
    // The gate that matters. The instant below is genuine — an account really is
    // locked until then — and it still must not reach a 401 or 402 caller, whose
    // correct action is to fix the credential, not to wait.
    const realReset = new Date(Date.now() + 120_000).toISOString();
    for (const status of [401, 402, 403]) {
      expect(
        retryAfter(errorResponse(status, 'terminal', { retryAfter: { at: realReset } })),
        `errorResponse ${status}`
      ).toBeNull();
      expect(
        retryAfter(unavailableResponse(status, 'terminal', realReset, 'reset after 2m')),
        `unavailableResponse ${status}`
      ).toBeNull();
    }
    // Control: the identical instant DOES produce a header on a retryable status,
    // so the assertions above are proving the gate and not a broken builder.
    expect(
      Number(retryAfter(errorResponse(503, 'transient', { retryAfter: { at: realReset } })))
    ).toBeGreaterThan(0);
    expect(
      Number(retryAfter(unavailableResponse(503, 'transient', realReset, 'reset after 2m')))
    ).toBeGreaterThan(0);
  });

  it('does not rotate an account on a policy rejection — the request is what was refused', () => {
    // A key pool has nothing to offer here: every key refuses the same content.
    // Rotating drains the pool one key per attempt for no possible gain.
    for (const text of [
      'Your request was rejected by our content policy',
      'content_policy_violation',
      'prohibited_content detected in the prompt',
      'blocked by safety filters',
    ]) {
      expect(checkFallbackError(400, text, 0), text).toEqual({
        shouldFallback: false,
        cooldownMs: 0,
      });
    }
    // 403 as a QUOTA reading still rotates (#2429's key_retry_on list), so the
    // new text rules narrowed nothing they should not have.
    expect(checkFallbackError(403, '', 0).shouldFallback).toBe(true);
  });

  it('never re-dispatches the SAME account after a terminal upstream status', async () => {
    // markAccountUnavailable reports a short cooldown, which is precisely the
    // condition the same-account fast retry path fires on. A terminal status has
    // to veto it anyway: three identical calls to a dead credential buy nothing.
    for (const status of [401, 402, 403]) {
      vi.clearAllMocks();
      authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 1 });
      let seen = 0;
      authMocks.getProviderCredentials.mockImplementation(async (_p, excluded) =>
        excluded?.size ? null : account('account-a')
      );
      dispatchMocks.handleChatCore.mockImplementation(() => {
        seen += 1;
        return failure(status, `terminal ${status}`);
      });

      const response = await handleChat(request());

      // One attempt on account-a, then the loop moves on rather than retrying it.
      expect(seen, `status ${status}`).toBe(1);
      expect(response.status, `status ${status}`).toBe(status);
    }
  });

  it('still retries the same account on a transient status', async () => {
    // The negative control for the case above: the veto is status-shaped, not a
    // blanket disabling of the retry path.
    let seen = 0;
    dispatchMocks.handleChatCore.mockImplementation(() => {
      seen += 1;
      return seen === 1 ? failure(500, 'transient glitch') : success();
    });

    const response = await handleChat(request());

    expect(response.status).toBe(200);
    expect(seen).toBe(2);
  });
});

describe('G4 — a local admission refusal tells the truth about itself', () => {
  it("answers a client rate-limit with the window's own reset, not a constant", async () => {
    // Burn the window, then assert the hint tracks the OLDEST hit's expiry: the
    // limiter already knew this and was throwing it away.
    const key = 'anonymous';
    // Burn to the CONFIGURED ceiling: RATE_LIMIT_MAX_REQUESTS is env-tunable
    // (src/sse/handlers/chat.js:89), so a literal 60 left the window unburnt
    // once the default moved and the handler answered 200 instead of 429.
    let limited = false;
    for (let i = 0; i < 10000 && !limited; i += 1) limited = __rateLimiter.isRateLimited(key);
    expect(limited).toBe(true);
    const expected = Math.ceil((__rateLimiter.resetAtMs(key) - Date.now()) / 1000);

    const response = await handleChat(request());

    expect(response.status).toBe(429);
    const secs = Number(retryAfter(response));
    expect(secs).toBeGreaterThan(0);
    expect(Math.abs(secs - expected)).toBeLessThanOrEqual(1);
    // Under the 60 s window, so it is the window and not a hardcoded default.
    expect(secs).toBeLessThanOrEqual(60);
    await expect(response.json()).resolves.toMatchObject({ error: { failure_phase: 'admission' } });
  });

  it('marks a local concurrency refusal as admission, and does not blame the provider', async () => {
    settingsMocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      providerThinking: {},
      providerStrategies: { codex: { maxConcurrent: 1 } },
    });
    const usageDb = await import('@/lib/usageDb.js');
    const spy = vi
      .spyOn(usageDb, 'getActiveRequests')
      .mockResolvedValue([{ provider: 'codex', model: 'gpt-5.6-sol', count: 1 }]);

    const response = await handleChat(request());

    expect(response.status).toBe(503);
    expect(Number(retryAfter(response))).toBeGreaterThanOrEqual(1);
    const payload = await response.json();
    // The phase marker, and a message that names the local gate rather than
    // asserting the upstream is full.
    expect(payload.error.failure_phase).toBe('admission');
    expect(payload.error.message).toContain('TokenProxy');
    expect(dispatchMocks.handleChatCore).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('marks an exhausted-account refusal as a PROVIDER failure, with the §4 floor', async () => {
    // The other side of the distinction: this one really is about the upstream,
    // and no account offered a reset instant, so the floor fills the absence
    // rather than leaving a retryable status with no hint at all.
    authMocks.getProviderCredentials.mockImplementation(async (_p, excluded) =>
      excluded?.size ? null : account('account-a')
    );
    dispatchMocks.handleChatCore.mockResolvedValue(failure(502, 'upstream exploded'));
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true,
      cooldownMs: 60_000,
    });

    const response = await handleChat(request());

    expect(response.status).toBe(502);
    expect(retryAfter(response)).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: { failure_phase: 'provider', message: 'upstream exploded' },
    });
  });

  it('prefers a real lock expiry over the floor when one exists', async () => {
    // All accounts locked with a known reset: the response reports THAT window,
    // which is the whole point of deriving from state.
    authMocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 120_000).toISOString(),
      retryAfterHuman: 'reset after 2m',
      lastError: 'all keys cooling',
      lastErrorCode: 429,
      clientErrorStatus: null,
    });

    const response = await handleChat(request());

    expect(response.status).toBe(429);
    expect(Number(retryAfter(response))).toBeGreaterThan(60);
    expect(dispatchMocks.handleChatCore).not.toHaveBeenCalled();
  });
});
