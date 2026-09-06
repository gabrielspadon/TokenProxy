import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// HANDLER-LEVEL companion to unit/long-context-depletion-latch.test.js, which
// covers the classifier and the three body builders in isolation. This file
// drives the real src/sse/handlers/chat.js account loop over TWO accounts of
// one claude model and asserts what that loop does with a long-context credit
// 429: rotate on the FIRST failure rather than replay the depleted account,
// and never relay either latch phrase to the client.
//
// Harness reused verbatim from tests/unit/chat-request-replay.test.js:18-46 --
// the same seven module mocks, the same credentials()/request() fixtures, the
// same `beforeAll` import of handleChat. Two mocks are widened rather than
// replaced, and both delegate to the SHIPPED code so nothing about the
// behaviour under test is re-implemented here:
//   * markAccountUnavailable mirrors auth.js:1224-1249 and calls the real
//     checkFallbackError / buildModelLockUpdateAt / buildModelFailureUpdate.
//   * getProviderCredentials mirrors auth.js:554-693 and calls the real
//     isModelLockActive / getActiveModelFailure / formatRetryAfter.
// open-sse/utils/error.js is deliberately NOT mocked, so every client-bound
// body below is produced by the real errorResponse / unavailableResponse.
import {
  LONG_CONTEXT_DEPLETION_MARKERS,
  LONG_CONTEXT_DEPLETION_COOLDOWN_MS,
  LONG_CONTEXT_DEPLETION_MESSAGE,
} from 'open-sse/config/errorConfig.js';
import {
  buildModelFailureUpdate,
  buildModelLockUpdateAt,
  checkFallbackError,
  formatRetryAfter,
  getActiveModelFailure,
  getModelLockKey,
  isModelLockActive,
} from 'open-sse/services/accountFallback.js';
import { ACCOUNT_ERROR_MESSAGE_MAX_CHARS } from 'open-sse/config/runtimeConfig.js';
import {
  createErrorResult,
  formatProviderError,
  parseUpstreamError,
} from 'open-sse/utils/error.js';

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const dispatchMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(() => '***'),
  warn: vi.fn(),
}));

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
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock('@/sse/utils/logger.js', () => logMocks);

const PROVIDER = 'claude';
const MODEL = 'claude-sonnet-4-5-20250929';
const LOCK_KEY = getModelLockKey(MODEL);
// chat.js:780. Above this the loop rotates instead of replaying the account.
const SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS = 30 * 1000;
// chat.js:776.
const ACCOUNT_RETRY_LIMIT = 3;

const carriesMarker = (text) =>
  LONG_CONTEXT_DEPLETION_MARKERS.some((m) => String(text).toLowerCase().includes(m));
// The upstream's own casing, taken from the exported marker rather than typed.
const upstreamPhrase = (marker) =>
  `${marker[0].toUpperCase()}${marker.slice(1)}. Please add credits to continue.`;

// The provider envelope a 429 actually arrives in. parseUpstreamError reads
// error.message out of it, so the phrase reaches the classifier exactly as it
// does in production.
const depletion429 = (marker) =>
  new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: upstreamPhrase(marker) },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } }
  );
const ordinary429 = () =>
  new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } }
  );
const ok200 = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });

// ---------------------------------------------------------------------------
// Fake connection store. Two accounts, one provider, one model.
// ---------------------------------------------------------------------------
let connections;
// connectionId -> () => Response  (the upstream this account answers with)
let upstreamByConn;
let coreCallsByConn;

// auth.js:1014 describeProviderError, for a string errorText.
const describeProviderError = (errorText) =>
  String(errorText).replace(/\s+/g, ' ').trim().slice(0, ACCOUNT_ERROR_MESSAGE_MAX_CHARS);

// auth.js:1224-1249. The classification and both update builders are the real
// ones, so the lock this writes is the lock the gateway writes.
// `_provider` is positional filler: chat.js:1120-1129 passes provider at index
// 3 and the `model` this lock is keyed on at index 4.
async function markAccountUnavailableFake(connectionId, status, errorText, _provider, model) {
  const conn = connections.find((c) => c.id === connectionId);
  const { shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(
    status,
    errorText,
    conn?.backoffLevel || 0
  );
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };
  const reason = describeProviderError(errorText);
  const until = new Date(Date.now() + cooldownMs).toISOString();
  Object.assign(conn, buildModelLockUpdateAt(model, until));
  Object.assign(
    conn,
    buildModelFailureUpdate(model, { status, message: reason, until, resetsAt: null })
  );
  conn.backoffLevel = newBackoffLevel ?? conn.backoffLevel ?? 0;
  return { shouldFallback, cooldownMs };
}

// auth.js:554-571 (the eligibility filter) and auth.js:665-693 (the
// every-account-locked answer), with the drain, quota and lease stages that
// this scenario does not exercise left out.
async function getProviderCredentialsFake(_provider, excludeSet, model, options) {
  const ignoreLockConn = options?.ignoreModelLockConnId || null;
  const available = connections.filter((c) => {
    if (excludeSet?.has(c.id)) return false;
    if (c.id === ignoreLockConn) return true;
    return !isModelLockActive(c, model);
  });
  if (available.length === 0) {
    const failure = connections
      .map((c) => getActiveModelFailure(c, model))
      .filter(Boolean)
      .sort((a, b) => a.until.localeCompare(b.until))[0];
    if (!failure) return null;
    return {
      allRateLimited: true,
      retryAfter: failure.until,
      retryAfterHuman: formatRetryAfter(failure.until),
      lastError: failure.message,
      lastErrorCode: failure.status,
      clientErrorStatus: failure.clientErrorStatus,
    };
  }
  const c = available[0];
  return {
    connectionId: c.id,
    connectionName: c.id,
    apiKey: 'provider-key',
    providerSpecificData: {},
  };
}

// chatCore.js:1799-2018, error tail only: parse the upstream body, format it,
// wrap it. `result.error` therefore carries the raw upstream text the
// classifier sees, and `result.response` is the real client-bound body.
async function handleChatCoreFake({ connectionId }) {
  coreCallsByConn.set(connectionId, (coreCallsByConn.get(connectionId) || 0) + 1);
  const upstream = upstreamByConn.get(connectionId)();
  if (upstream.ok) return { success: true, response: upstream };
  const { statusCode, message, resetsAtMs } = await parseUpstreamError(upstream);
  return createErrorResult(
    statusCode,
    formatProviderError(new Error(message), statusCode),
    resetsAtMs,
    null,
    'rid-depletion'
  );
}

const request = () =>
  new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `${PROVIDER}/${MODEL}`,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

let handleChat;

beforeAll(async () => {
  ({ handleChat } = await import('../../src/sse/handlers/chat.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  connections = [
    { id: 'account-a', backoffLevel: 0 },
    { id: 'account-b', backoffLevel: 0 },
  ];
  upstreamByConn = new Map();
  coreCallsByConn = new Map();
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: false,
    providerThinking: {},
    providerStrategies: {},
    cavemanEnabled: false,
    ponytailEnabled: false,
    ccFilterNaming: false,
    rtkEnabled: false,
    headroomEnabled: false,
    pxpipeEnabled: false,
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: PROVIDER, model: MODEL });
  authMocks.getProviderCredentials.mockImplementation(getProviderCredentialsFake);
  authMocks.markAccountUnavailable.mockImplementation(markAccountUnavailableFake);
  dispatchMocks.handleChatCore.mockImplementation(handleChatCoreFake);
});

describe('long-context credit 429 through the chat handler: one account depleted', () => {
  it.each(LONG_CONTEXT_DEPLETION_MARKERS)(
    'rotates A→B on the FIRST %j and locks A for the model',
    async (marker) => {
      upstreamByConn.set('account-a', () => depletion429(marker));
      upstreamByConn.set('account-b', ok200);

      const response = await handleChat(request());

      // The client is served by B.
      expect(response.status).toBe(200);
      expect(coreCallsByConn.get('account-b')).toBe(1);
      // ROTATED, not retried: A was dispatched to exactly once, well short of
      // the ACCOUNT_RETRY_LIMIT an ordinary retryable 429 would earn it.
      expect(coreCallsByConn.get('account-a')).toBe(1);
      expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(2);
      // The recorded fallback decision: a lock long enough to clear the
      // same-account retry window, which is what forced the rotation.
      const decision = await authMocks.markAccountUnavailable.mock.results[0].value;
      expect(decision).toEqual({
        shouldFallback: true,
        cooldownMs: LONG_CONTEXT_DEPLETION_COOLDOWN_MS,
      });
      expect(decision.cooldownMs).toBeGreaterThan(SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS);
      // modelLock_<model> is set on A, for this model only, and B is untouched.
      const [a, b] = connections;
      const lockedUntil = Date.parse(a[LOCK_KEY]);
      expect(Number.isFinite(lockedUntil)).toBe(true);
      expect(lockedUntil - Date.now()).toBeGreaterThan(LONG_CONTEXT_DEPLETION_COOLDOWN_MS - 10_000);
      expect(isModelLockActive(a, MODEL)).toBe(true);
      expect(b[LOCK_KEY]).toBeUndefined();
      // The phrase reached the classifier (that is what earned the lock) and
      // never reached the client.
      expect(carriesMarker(authMocks.markAccountUnavailable.mock.calls[0][2])).toBe(true);
      expect(carriesMarker(await response.clone().text())).toBe(false);
    }
  );
});

describe('long-context credit 429 through the chat handler: pool depleted', () => {
  it.each(LONG_CONTEXT_DEPLETION_MARKERS)(
    'answers 429 without %j, with the substitute message and retry information',
    async (marker) => {
      upstreamByConn.set('account-a', () => depletion429(marker));
      upstreamByConn.set('account-b', () => depletion429(marker));

      const response = await handleChat(request());

      // Both accounts tried once each, then the pool-exhausted answer.
      expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(2);
      expect(coreCallsByConn.get('account-a')).toBe(1);
      expect(coreCallsByConn.get('account-b')).toBe(1);
      expect(response.status).toBe(429);

      const raw = await response.text();
      // The latch phrase is gone in EITHER spelling, case-insensitively, even
      // though the stored lastError this body is built from still carries it.
      expect(carriesMarker(raw)).toBe(false);
      expect(raw.toLowerCase()).not.toContain(marker);
      expect(raw).toContain(LONG_CONTEXT_DEPLETION_MESSAGE);
      // The rewrite happens on the way OUT. The stored failure metadata this
      // body is built from still carries the phrase, which is the whole reason
      // unavailableResponse has to scrub rather than trusting its input.
      expect(carriesMarker(getActiveModelFailure(connections[0], MODEL).message)).toBe(true);

      // Retry information survives the rewrite, in the header and the prose.
      const retryAfter = Number(response.headers.get('Retry-After'));
      expect(Number.isFinite(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS / 1000);
      expect(retryAfter).toBeLessThanOrEqual(LONG_CONTEXT_DEPLETION_COOLDOWN_MS / 1000);
      const body = JSON.parse(raw);
      expect(body.error.message).toContain(formatRetryAfter(connections[0][LOCK_KEY]));
    }
  );
});

describe('control: an ordinary 429 keeps the behaviour it had', () => {
  it('still rotates A→B, after the same-account retries a plain rate limit earns', async () => {
    upstreamByConn.set('account-a', ordinary429);
    upstreamByConn.set('account-b', ok200);

    const response = await handleChat(request());

    expect(response.status).toBe(200);
    // The contrast with the depletion case above: a plain 429 is a window, so
    // A is replayed up to the limit BEFORE the loop moves on. The depletion
    // 429 skips all of that on the strength of its cooldown alone.
    expect(coreCallsByConn.get('account-a')).toBe(ACCOUNT_RETRY_LIMIT);
    expect(coreCallsByConn.get('account-b')).toBe(1);
    const decision = await authMocks.markAccountUnavailable.mock.results[0].value;
    expect(decision.shouldFallback).toBe(true);
    expect(decision.cooldownMs).toBeLessThanOrEqual(SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS);
    expect(decision.cooldownMs).toBeLessThan(LONG_CONTEXT_DEPLETION_COOLDOWN_MS);
    expect(carriesMarker(await response.clone().text())).toBe(false);
  });
});
