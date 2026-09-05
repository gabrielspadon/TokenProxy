// GithubExecutor transport contract: header set (Copilot token, no leak of the
// GitHub OAuth token when a copilotToken exists), request transformation,
// endpoint routing between /chat/completions, /responses and /v1/messages,
// escalation caching (#3477), error pass-through, and token refresh chain.
// Complements github-responses-routing (#1062) and github-prefill-sanitize.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { GithubExecutor } = await import('../../open-sse/executors/github.js');
const { GITHUB_COPILOT } = await import('../../open-sse/config/appConstants.js');

beforeEach(() => fetchMock.mockReset());

describe('GithubExecutor.buildHeaders', () => {
  const ex = new GithubExecutor();

  it('prefers copilotToken over accessToken — the GitHub OAuth token must not go upstream when a Copilot token exists', () => {
    const h = ex.buildHeaders({ copilotToken: 'cop-1', accessToken: 'gho_secret' });
    expect(h['Authorization']).toBe('Bearer cop-1');
    expect(JSON.stringify(h)).not.toContain('gho_secret');
  });

  it('falls back to accessToken when no copilotToken, and carries the Copilot identity headers', () => {
    const h = ex.buildHeaders({ accessToken: 'gho_only' }, true);
    expect(h['Authorization']).toBe('Bearer gho_only');
    expect(h['copilot-integration-id']).toBe('vscode-chat');
    expect(h['editor-version']).toBe(`vscode/${GITHUB_COPILOT.VSCODE_VERSION}`);
    expect(h['Accept']).toBe('text/event-stream');
    expect(ex.buildHeaders({ accessToken: 't' }, false)['Accept']).toBe('application/json');
  });
});

describe('GithubExecutor.transformRequest', () => {
  const ex = new GithubExecutor();

  it('renames max_tokens → max_completion_tokens for gpt-5/o-series only', () => {
    const out = ex.transformRequest('gpt-5.2', { max_tokens: 100 }, true, {});
    expect(out.max_completion_tokens).toBe(100);
    expect(out.max_tokens).toBeUndefined();
    const kept = ex.transformRequest('gpt-4.1', { max_tokens: 100 }, true, {});
    expect(kept.max_tokens).toBe(100);
    expect(kept.max_completion_tokens).toBeUndefined();
  });

  it('strips reasoning_effort:"none" but keeps real values', () => {
    expect(
      ex.transformRequest('gpt-4.1', { reasoning_effort: 'none' }, true, {}).reasoning_effort
    ).toBeUndefined();
    expect(
      ex.transformRequest('gpt-4.1', { reasoning_effort: 'high' }, true, {}).reasoning_effort
    ).toBe('high');
  });

  it("does not mutate the caller's body", () => {
    const body = { max_tokens: 5, reasoning_effort: 'none' };
    ex.transformRequest('gpt-5.2', body, true, {});
    expect(body).toEqual({ max_tokens: 5, reasoning_effort: 'none' });
  });
});

describe('GithubExecutor.sanitizeMessagesForChatCompletions', () => {
  const ex = new GithubExecutor();

  it('serializes tool_result/thinking parts as text and keeps text/image_url', () => {
    const out = ex.sanitizeMessagesForChatCompletions({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'keep' },
            { type: 'image_url', image_url: { url: 'u' } },
            { type: 'tool_result', content: 'tool says' },
          ],
        },
        { role: 'user', content: 'ok' },
      ],
    });
    const parts = out.messages[0].content;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text']);
    expect(parts[2].text).toBe('tool says');
  });

  it('drops content down to null when everything is stripped, and keeps assistant tool_calls messages', () => {
    const out = ex.sanitizeMessagesForChatCompletions({
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] },
        { role: 'user', content: [{ type: 'text', text: '' }] },
      ],
    });
    expect(out.messages[0].tool_calls).toEqual([{ id: 't1' }]);
    expect(out.messages[1].content).toBeNull();
  });
});

describe('GithubExecutor.execute — endpoint routing', () => {
  it('claude-* models go to /v1/messages, never /chat/completions', async () => {
    const ex = new GithubExecutor();
    const spy = vi.spyOn(ex, 'executeWithMessagesEndpoint').mockResolvedValue({ via: 'messages' });
    const out = await ex.execute({ model: 'claude-sonnet-4.6', body: { messages: [] }, log: null });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.via).toBe('messages');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("escalates a 400 'not accessible via /chat/completions' to /responses, but caches the route ONLY on success (#3477)", async () => {
    const ex = new GithubExecutor();
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(ex)), 'execute').mockResolvedValue({
      response: new Response('model is not accessible via the /chat/completions endpoint', {
        status: 400,
      }),
    });
    const respSpy = vi
      .spyOn(ex, 'executeWithResponsesEndpoint')
      .mockResolvedValueOnce({ response: { ok: false, status: 400 } })
      .mockResolvedValueOnce({ response: { ok: true, status: 200 } });

    await ex.execute({ model: 'gpt-5.5-codex', body: { messages: [] }, log: null });
    expect(ex.knownCodexModels.has('gpt-5.5-codex')).toBe(false); // failed attempt not cached

    await ex.execute({ model: 'gpt-5.5-codex', body: { messages: [] }, log: null });
    expect(ex.knownCodexModels.has('gpt-5.5-codex')).toBe(true); // successful serve cached
    expect(respSpy).toHaveBeenCalledTimes(2);
  });

  it('an unrelated 400 is NOT escalated: the real error body reaches the caller', async () => {
    const ex = new GithubExecutor();
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(ex)), 'execute').mockResolvedValue({
      response: new Response('bad request: invalid tool schema', { status: 400 }),
    });
    const respSpy = vi.spyOn(ex, 'executeWithResponsesEndpoint');
    const out = await ex.execute({ model: 'gpt-4.1', body: { messages: [] }, log: null });
    expect(respSpy).not.toHaveBeenCalled();
    expect(out.response.status).toBe(400);
    expect(await out.response.clone().text()).toContain('invalid tool schema');
  });
});

describe('GithubExecutor.executeWithResponsesEndpoint — non-2xx pass-through', () => {
  it('returns the upstream error response without wrapping it in a translated stream', async () => {
    const ex = new GithubExecutor();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 402 })
    );
    const out = await ex.executeWithResponsesEndpoint({
      model: 'gpt-5.5-codex',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: true,
      credentials: { copilotToken: 'cop' },
    });
    expect(out.response.status).toBe(402);
    expect(await out.response.text()).toContain('nope');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ex.config.responsesUrl);
    expect(init.headers['Authorization']).toBe('Bearer cop');
  });
});

describe('GithubExecutor token refresh', () => {
  it('refreshCopilotToken exchanges the GitHub token with `token` scheme at copilot_internal, null on failure', async () => {
    const ex = new GithubExecutor();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'cop-new', expires_at: 123 }), { status: 200 })
    );
    const r = await ex.refreshCopilotToken('gho_x', null);
    expect(r).toEqual({ token: 'cop-new', expiresAt: 123 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/copilot_internal/v2/token');
    expect(init.headers['Authorization']).toBe('token gho_x');

    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    expect(await ex.refreshCopilotToken('gho_x', null)).toBeNull();
  });

  it('refreshCredentials falls back to the GitHub refresh token chain when the Copilot exchange fails', async () => {
    const ex = new GithubExecutor();
    vi.spyOn(ex, 'refreshCopilotToken')
      .mockResolvedValueOnce(null) // first exchange with old token fails
      .mockResolvedValueOnce({ token: 'cop-2', expiresAt: 'later' }); // exchange with refreshed token
    vi.spyOn(ex, 'refreshGitHubToken').mockResolvedValue({
      accessToken: 'gho_new',
      refreshToken: 'ghr_new',
      expiresIn: 3600,
    });
    const out = await ex.refreshCredentials(
      { accessToken: 'gho_old', refreshToken: 'ghr_old' },
      null
    );
    expect(out).toMatchObject({
      accessToken: 'gho_new',
      refreshToken: 'ghr_new',
      copilotToken: 'cop-2',
      copilotTokenExpiresAt: 'later',
    });
  });

  it('refreshCredentials returns null when every path fails — caller must see the failure', async () => {
    const ex = new GithubExecutor();
    vi.spyOn(ex, 'refreshCopilotToken').mockResolvedValue(null);
    vi.spyOn(ex, 'refreshGitHubToken').mockResolvedValue(null);
    expect(await ex.refreshCredentials({ accessToken: 'a', refreshToken: 'r' }, null)).toBeNull();
  });
});

describe('GithubExecutor.needsRefresh', () => {
  const ex = new GithubExecutor();

  it('true without a copilotToken; true within the 5-minute expiry window; false when fresh', () => {
    expect(ex.needsRefresh({})).toBe(true);
    const soonSec = Math.floor((Date.now() + 60 * 1000) / 1000); // Unix seconds, expires in 1min
    expect(ex.needsRefresh({ copilotToken: 'c', copilotTokenExpiresAt: soonSec })).toBe(true);
    const laterIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(ex.needsRefresh({ copilotToken: 'c', copilotTokenExpiresAt: laterIso })).toBe(false);
  });
});
