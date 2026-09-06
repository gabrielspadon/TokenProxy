import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ core: vi.fn(), credentials: vi.fn(), mark: vi.fn(), settings: vi.fn(), model: vi.fn() }));
vi.mock('@/sse/services/auth.js', () => ({
  extractApiKey: () => null, isValidApiKey: vi.fn(async () => true),
  getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.mark, clearAccountError: vi.fn(),
}));
vi.mock('open-sse/handlers/chatCore.js', () => ({ handleChatCore: mocks.core }));
vi.mock('@/sse/services/model.js', async (original) => ({ ...(await original()), getComboModels: vi.fn(async () => null), getModelInfo: mocks.model }));
vi.mock('@/lib/localDb', () => ({ getSettings: mocks.settings }));
vi.mock('@/sse/services/tokenRefresh.js', () => ({ checkAndRefreshToken: vi.fn(async (_p, c) => c), updateProviderCredentials: vi.fn() }));
vi.mock('@/sse/utils/logger.js', () => ({ debug: vi.fn(), info: vi.fn(), maskKey: () => 'fixture', warn: vi.fn() }));

const { handleChat } = await import('../../../src/sse/handlers/chat.js');
const credential = (id) => ({ connectionId: id, connectionName: id, apiKey: 'fixture-only', providerSpecificData: {} });
const success = () => ({ success: true, response: Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] }) });
function failure(status, safeToReplay) {
  const error = status === 507 ? 'exceeded request buffer limit while retrying upstream' : 'fixture upstream failure';
  return { success: false, status, error, ...(safeToReplay === undefined ? {} : { failureMetadata: { safeToReplay } }), response: Response.json({ error: { message: error }, partial: 'possibly billable generation' }, { status }) };
}
function request(signal, stream = false) {
  return new Request('http://localhost/v1/chat/completions', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex/gpt-5.6-sol', stream, messages: [{ role: 'user', content: 'Perform the requested transaction exactly once.' }] }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request in platform audit'); }));
  mocks.settings.mockResolvedValue({ requireApiKey: false, providerThinking: {}, providerStrategies: {} });
  mocks.model.mockResolvedValue({ provider: 'codex', model: 'gpt-5.6-sol' });
  mocks.credentials.mockImplementation(async (_p, excluded) => excluded.has('account-a') ? credential('account-b') : credential('account-a'));
  mocks.mark.mockResolvedValue({ shouldFallback: true, mustWait: false, cooldownMs: 1000 });
});
afterEach(() => vi.unstubAllGlobals());

describe('independent money boundary at the real chat coordinator', () => {
  it.each([429, 503, 507])('does not replay an uncertain or partial %i failure', async (status) => {
    mocks.core.mockResolvedValueOnce(failure(status, false)).mockImplementation(success);
    const response = await handleChat(request());
    expect(response.status).toBe(status);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    await response.text();
  });

  it('fails closed when replay safety evidence is absent', async () => {
    mocks.core.mockResolvedValueOnce(failure(503)).mockImplementation(success);
    const response = await handleChat(request());
    expect(response.status).toBe(503);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    await response.text();
  });

  it('starts each safe account attempt with the pristine caller body', async () => {
    const original = { model: 'codex/gpt-5.6-sol', messages: [{ role: 'user', content: [{ type: 'text', text: 'Exact nested caller text.' }] }] };
    mocks.core.mockImplementationOnce(async ({ body }) => {
      body.messages[0].content[0].text = 'attempt-one rewrite';
      return failure(429, true);
    }).mockImplementation(success);
    const incoming = new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(original) });
    const response = await handleChat(incoming);
    expect(response.status).toBe(200);
    expect(mocks.core.mock.calls[1][0].body.messages).toEqual(original.messages);
    expect(mocks.core.mock.calls[1][0].modelInfo).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
    await response.text();
  });

  it.each([429, 503])('rotates after an explicit safe %i account rejection without retrying the rejected account or changing model', async (status) => {
    mocks.core.mockResolvedValueOnce(failure(status, true)).mockImplementation(success);
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(mocks.core.mock.calls.map(([args]) => args.connectionId)).toEqual(['account-a', 'account-b']);
    expect(mocks.core.mock.calls.map(([args]) => args.modelInfo)).toEqual([
      { provider: 'codex', model: 'gpt-5.6-sol' }, { provider: 'codex', model: 'gpt-5.6-sol' },
    ]);
    expect(mocks.mark.mock.calls[0][6]).toEqual({ safeToReplay: true });
    await response.text();
  });

  it.each([429, 503])('waits for a transient %i cooldown without rotating a healthy pin', async (status) => {
    mocks.mark.mockResolvedValue({ shouldFallback: false, mustWait: true, cooldownMs: 1000 });
    const rejected = failure(status, true);
    rejected.response.headers.set('retry-after', '1');
    mocks.core.mockResolvedValueOnce(rejected).mockImplementation(success);
    const response = await handleChat(request());
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
    await response.text();
  });

  it('does not dispatch again when the caller aborts after the first attempt', async () => {
    const controller = new AbortController();
    mocks.core.mockImplementationOnce(async () => { controller.abort(); return failure(503, true); }).mockImplementation(success);
    const response = await handleChat(request(controller.signal));
    expect(response.status).toBe(499);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    await response.text();
  });

  it('does not replay an accepted empty SSE response', async () => {
    mocks.core.mockResolvedValueOnce({ success: true, response: new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) }).mockImplementation(success);
    const response = await handleChat(request(undefined, true));
    expect(response.status).toBe(502);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    await response.text();
  });

  it('hands a visible partial stream to the caller without account rotation', async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n'));
      else controller.error(new Error('fixture connection lost'));
    } });
    mocks.core.mockResolvedValueOnce({ success: true, response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) }).mockImplementation(success);
    const response = await handleChat(request(undefined, true));
    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial answer');
    await expect(reader.read()).rejects.toThrow('fixture connection lost');
    expect(mocks.core).toHaveBeenCalledTimes(1);
  });
});
