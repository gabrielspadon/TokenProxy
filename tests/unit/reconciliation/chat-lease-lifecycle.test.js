import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// E1.1w — every exit of handleSingleModelChat gives the admission slot back.
//
// The handler's loop has many more exits than it looks like: the pinned-account
// refusal, the all-unavailable return, the abort/499, the empty-stream rotation,
// the request-replay retry, the same-account retry, the next-account rotation,
// the attempt-ceiling return, the terminal success, and any throw out of
// handleChatCore. A leak on any one of them permanently shrinks that account's
// ceiling for the life of the process, and nothing observable fails: the account
// just quietly serves fewer requests.
//
// Selection is mocked because the scheduler is not what this file constrains
// (scheduler-wiring.test.js does that). The LEASE REGISTRY IS REAL and the
// leases handed to the handler are real reservations taken from it, so
// `inFlight()` here is the same number the ceiling is enforced against. Mocking
// the registry too would leave this asserting that a mock was called.
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
  error: vi.fn(),
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

let handleChat;
let registry;
let leaseRegistryModule;

// Selection hands the handler a REAL reservation, the way auth.js does.
function leased(connectionId) {
  const lease = registry.reserve(connectionId);
  expect(lease).toBeTruthy();
  return {
    connectionId,
    connectionName: connectionId,
    // SYNTHETIC and obviously fake. Never read from the environment.
    apiKey: 'sk-fake-testonly-cccc2222cccc2222cccc2222',
    providerSpecificData: {},
    accountLease: lease,
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

// A real SSE response, because the success path runs peekStreamForContent and
// only an `text/event-stream` body reaches the peek at all.
function sseResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function streamWithContent() {
  return sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']);
}

function emptyStream() {
  return sseResponse(['data: [DONE]\n\n']);
}

async function drain(response) {
  if (!response?.body) return;
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {
    /* the client reading to the end is what ends the lease on a handoff */
  }
}

beforeAll(async () => {
  leaseRegistryModule = await import('@/sse/services/accountLeaseRegistry.js');
  registry = leaseRegistryModule._getLeaseRegistry();
  ({ handleChat } = await import('@/sse/handlers/chat.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: false,
    providerThinking: {},
    cavemanEnabled: false,
    ponytailEnabled: false,
    ccFilterNaming: false,
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: 'codex', model: 'gpt-5.6-sol' });
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
  authMocks.getProviderCredentials.mockImplementation(async () => leased('account-a'));
  // The registry is module state and outlives one test. Starting from a clean
  // slate is what makes `inFlight()` an absolute assertion rather than a delta.
  for (const [id, count] of Object.entries(registry.snapshot())) {
    throw new Error(`registry dirty before test: ${id}=${count}`);
  }
});

describe('E1.1w: handleSingleModelChat releases its lease on every exit', () => {
  it('terminal success: holds through the stream, releases when the body ends', async () => {
    dispatchMocks.handleChatCore.mockImplementation(() => ({
      success: true,
      response: streamWithContent(),
    }));

    const response = await handleChat(request());
    expect(response.status).toBe(200);
    // STILL HELD. The handler has returned but the client has read nothing, and
    // a slot released here would report the account idle for the whole stream.
    expect(registry.inFlight('account-a')).toBe(1);

    await drain(response);
    expect(registry.snapshot()).toEqual({});
  });

  it('client abort: releases without waiting for a body that nobody will read', async () => {
    dispatchMocks.handleChatCore.mockImplementation(() => ({
      success: false,
      status: 499,
      clientAborted: true,
      error: 'client aborted',
      response: new Response(null, { status: 499 }),
    }));

    const response = await handleChat(request());
    expect(response.status).toBe(499);
    expect(registry.snapshot()).toEqual({});
  });

  it('empty accepted stream returns without replay and releases its slot', async () => {
    const seen = [];
    authMocks.getProviderCredentials.mockImplementation(async (_p, exclude) => {
      const id = exclude?.has('account-a') ? 'account-b' : 'account-a';
      seen.push(id);
      return leased(id);
    });
    dispatchMocks.handleChatCore.mockImplementation(({ connectionId }) =>
      connectionId === 'account-a'
        ? { success: true, response: emptyStream() }
        : { success: true, response: streamWithContent() }
    );

    const response = await handleChat(request());
    expect(seen).toEqual(['account-a']);
    expect(response.status).toBe(503);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(registry.inFlight('account-a')).toBe(0);
    expect(registry.inFlight('account-b')).toBe(0);

    await drain(response);
    expect(registry.snapshot()).toEqual({});
  });

  it('request replay: the retried attempt does not stack a second slot', async () => {
    let attempts = 0;
    dispatchMocks.handleChatCore.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        const error = '[507]: exceeded request buffer limit while retrying upstream';
        return {
          success: false,
          status: 507,
          failureMetadata: { safeToReplay: true },
          error,
          response: Response.json({ error: { message: error } }, { status: 507 }),
        };
      }
      return { success: true, response: streamWithContent() };
    });

    const response = await handleChat(request());
    expect(attempts).toBe(2);
    expect(response.status).toBe(200);
    // TWO leases were taken (one per attempt) and exactly one is still open.
    // Without the release before `continue`, this reads 2 and the account has
    // permanently lost a slot it will never get back.
    expect(registry.inFlight('account-a')).toBe(1);

    await drain(response);
    expect(registry.snapshot()).toEqual({});
  });

  it('attempt ceiling: the capped return still releases', async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 0 });
    dispatchMocks.handleChatCore.mockImplementation(() => ({
      success: false,
      status: 500,
      failureMetadata: { safeToReplay: true },
      error: 'upstream boom',
      response: Response.json({ error: { message: 'upstream boom' } }, { status: 500 }),
    }));

    const response = await handleChat(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The ceiling is a HEADER (chat.js:46 REQUEST_MAX_ATTEMPTS_HEADER),
          // not a body field. As a body field it is ignored, and with
          // markAccountUnavailable always saying shouldFallback the loop
          // rotates forever - which is what killed the worker rather than
          // failing an assertion.
          'x-max-attempts': '1',
        },
        body: JSON.stringify({
          model: 'codex/gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
    );
    expect(response.status).toBe(500);
    await drain(response);
    expect(registry.snapshot()).toEqual({});
  });

  it('a throw out of the core releases through the finally', async () => {
    dispatchMocks.handleChatCore.mockImplementation(() => {
      throw new Error('core exploded');
    });

    await expect(handleChat(request())).rejects.toThrow('core exploded');
    // Nothing downstream ever learned this lease existed, so `finally` is the
    // only thing that can free it.
    expect(registry.snapshot()).toEqual({});
  });

  it('all accounts unavailable: the refusal path takes no slot with it', async () => {
    authMocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 1000).toISOString(),
      retryAfterHuman: '1s',
      lastError: 'at capacity',
    });

    const response = await handleChat(request());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(registry.snapshot()).toEqual({});
  });

  it("a pinned account the scheduler substituted away releases the substitute's slot", async () => {
    // The caller named account-a; selection returned account-b. The handler
    // refuses rather than spending the wrong subscription, and that refusal is
    // an exit AFTER the reservation, so it must give the slot back.
    authMocks.getProviderCredentials.mockImplementation(async () => leased('account-b'));

    const response = await handleChat(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // chat.js:44 REQUEST_CONNECTION_HEADER. Also a header, not a body field.
          'x-connection-id': 'account-a',
        },
        body: JSON.stringify({
          model: 'codex/gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
    );
    expect(response.status).toBe(503);
    expect(registry.snapshot()).toEqual({});
  });
});
