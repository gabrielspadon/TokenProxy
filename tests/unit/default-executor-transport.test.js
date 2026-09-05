// DefaultExecutor transport contract: endpoint override path carry-over,
// buildUrl branches (gemini :streamGenerateContent, urlSuffix, {accountId}),
// forced streaming + stream_options.include_usage for the official OpenAI
// transport (usage accounting depends on it), max_completion_tokens rename,
// client_metadata scoping, anthropic-compatible header hygiene, and the
// OAuth refresh grant plumbing. Areas already locked elsewhere are skipped:
// #1702 floor retry, #3662 muse-spark, #2660 operator headers, #1523 no-key.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { DefaultExecutor, applyEndpointOverride } =
  await import('../../open-sse/executors/default.js');
const { ANTHROPIC_API_VERSION } = await import('../../open-sse/providers/shared.js');

beforeEach(() => fetchMock.mockReset());

describe('applyEndpointOverride', () => {
  it('carries the registry operation path onto a bare stored base', () => {
    expect(
      applyEndpointOverride('https://gw.example/v1', 'https://api.openai.com/v1/chat/completions')
    ).toBe('https://gw.example/v1/chat/completions');
  });

  it('does not double the path when the stored base already ends in it', () => {
    expect(
      applyEndpointOverride(
        'https://gw.example/v1/chat/completions',
        'https://api.openai.com/v1/chat/completions'
      )
    ).toBe('https://gw.example/v1/chat/completions');
  });

  it('longest path wins: /images/generations is not mistaken for /generations (#3253)', () => {
    expect(applyEndpointOverride('https://gw.example', 'https://x/v1/images/generations')).toBe(
      'https://gw.example/images/generations'
    );
  });

  it('empty/blank override leaves the registry URL; unrecognized registry tail stands alone', () => {
    expect(applyEndpointOverride(undefined, 'https://x/v1/chat/completions')).toBe(
      'https://x/v1/chat/completions'
    );
    expect(applyEndpointOverride('  ', 'https://x/v1/chat/completions')).toBe(
      'https://x/v1/chat/completions'
    );
    expect(applyEndpointOverride('https://gw.example/', 'https://host.example')).toBe(
      'https://gw.example'
    );
  });
});

describe('DefaultExecutor.buildUrl', () => {
  it('gemini format: model-templated path split by stream', () => {
    const ex = new DefaultExecutor('gemini');
    // gemini registry format is gemini; verify the :verb suffix logic.
    if (ex.config.format === 'gemini') {
      expect(ex.buildUrl('gemini-3-pro', true)).toMatch(
        /gemini-3-pro:streamGenerateContent\?alt=sse$/
      );
      expect(ex.buildUrl('gemini-3-pro', false)).toMatch(/gemini-3-pro:generateContent$/);
    }
  });

  it('{accountId} substitution: filled from providerSpecificData, throws without it', () => {
    const ex = new DefaultExecutor('cloudflare-ai');
    const url = ex.buildUrl('m', true, 0, { providerSpecificData: { accountId: 'acc-9' } });
    expect(url).toContain('/accounts/acc-9/');
    expect(url).not.toContain('{accountId}');
    expect(() => ex.buildUrl('m', true, 0, {})).toThrow(/accountId/);
  });

  it('runtimeTransport baseUrl wins over everything, with optional urlSuffix', () => {
    const ex = new DefaultExecutor('openai');
    expect(
      ex.buildUrl('m', true, 0, {
        runtimeTransport: { baseUrl: 'https://rt.example/v1', urlSuffix: '/chat' },
      })
    ).toBe('https://rt.example/v1/chat');
    expect(
      ex.buildUrl('m', true, 0, { runtimeTransport: { baseUrl: 'https://rt.example/v1' } })
    ).toBe('https://rt.example/v1');
  });

  it('per-connection endpoint override keeps the provider operation path', () => {
    const ex = new DefaultExecutor('openai');
    expect(
      ex.buildUrl('m', true, 0, { providerSpecificData: { baseUrl: 'https://relay.example/v1' } })
    ).toBe('https://relay.example/v1/chat/completions');
  });
});

describe('DefaultExecutor.transformRequest — official OpenAI usage accounting', () => {
  const ex = new DefaultExecutor('openai');

  it('forces stream:true and injects stream_options.include_usage for a JSON client', () => {
    const out = ex.transformRequest('gpt-4.1', { messages: [], stream: false }, true, {});
    expect(out.stream).toBe(true);
    // Without include_usage the forced-stream response carries no usage frame
    // and the proxy under-reports tokens for every non-streaming client.
    expect(out.stream_options).toMatchObject({ include_usage: true });
  });

  it('does not inject stream_options when the client itself asked to stream', () => {
    const out = ex.transformRequest('gpt-4.1', { messages: [], stream: true }, true, {});
    expect(out.stream).toBe(true);
    expect(out.stream_options).toBeUndefined();
  });

  it('renames max_tokens → max_completion_tokens for gpt-5/o-series, value preserved', () => {
    const out = ex.transformRequest('gpt-5.2', { messages: [], max_tokens: 777 }, true, {});
    expect(out.max_completion_tokens).toBe(777);
    expect(out.max_tokens).toBeUndefined();
    // An explicit max_completion_tokens is not clobbered.
    const kept = ex.transformRequest(
      'o3-mini',
      { messages: [], max_tokens: 5, max_completion_tokens: 9 },
      true,
      {}
    );
    expect(kept.max_completion_tokens).toBe(9);
    // Legacy models keep max_tokens.
    const legacy = ex.transformRequest('gpt-4.1', { messages: [], max_tokens: 5 }, true, {});
    expect(legacy.max_tokens).toBe(5);
  });

  it('drops client_metadata for a non-claude-format provider but keeps it for anthropic', () => {
    const openaiOut = ex.transformRequest(
      'gpt-4.1',
      { messages: [], client_metadata: { x: 1 } },
      true,
      {}
    );
    expect(openaiOut.client_metadata).toBeUndefined();
    const anthropic = new DefaultExecutor('anthropic');
    const claudeOut = anthropic.transformRequest(
      'claude-sonnet-4.6',
      { messages: [], client_metadata: { x: 1 } },
      true,
      {}
    );
    expect(claudeOut.client_metadata).toEqual({ x: 1 });
  });
});

describe('DefaultExecutor.buildHeaders — anthropic official vs compatible', () => {
  it('official anthropic: x-api-key auth, version header, and an Anthropic-Beta for the model', () => {
    const ex = new DefaultExecutor('anthropic');
    const h = ex.buildHeaders({ apiKey: 'sk-ant' }, true, undefined, 'claude-sonnet-4.6');
    expect(h['x-api-key']).toBe('sk-ant');
    expect(h['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(h['Anthropic-Beta']).toBeTruthy();
  });

  it('client-supplied anthropic-beta flags are merged into the base set, not dropped', () => {
    const ex = new DefaultExecutor('anthropic');
    const h = ex.buildHeaders(
      { apiKey: 'sk-ant', rawHeaders: { 'anthropic-beta': 'my-extra-beta' } },
      true,
      undefined,
      'claude-sonnet-4.6'
    );
    expect(h['Anthropic-Beta']).toContain('my-extra-beta');
  });

  it('third-party anthropic-compatible upstream: identity headers stripped, claude-code beta removed, Bearer added beside x-api-key', () => {
    const ex = new DefaultExecutor('anthropic-compatible-x');
    // resolveAuthDescriptor path: not in AUTH_DESCRIPTORS registry.
    const h = ex.buildHeaders(
      { apiKey: 'sk-3p', providerSpecificData: { baseUrl: 'https://third.example/v1' } },
      true,
      undefined,
      'claude-sonnet-4.6'
    );
    expect(h['x-api-key']).toBe('sk-3p');
    expect(h['Authorization']).toBe('Bearer sk-3p');
    expect(h['x-app']).toBeUndefined();
    expect(h['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    for (const key of ['Anthropic-Beta', 'anthropic-beta']) {
      if (h[key]) expect(h[key]).not.toContain('claude-code-20250219');
    }
  });
});

describe('DefaultExecutor.refreshCredentials — grant plumbing', () => {
  it('returns null with no refreshToken and for providers without a refresher', async () => {
    const ex = new DefaultExecutor('claude');
    expect(await ex.refreshCredentials({}, null)).toBeNull();
    const openai = new DefaultExecutor('openai');
    expect(await openai.refreshCredentials({ refreshToken: 'r' }, null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('claude refresh posts grant_type=refresh_token and maps the token response', async () => {
    const ex = new DefaultExecutor('claude');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
        }),
        { status: 200 }
      )
    );
    const out = await ex.refreshCredentials({ refreshToken: 'old-rt' }, null);
    expect(out).toEqual({ accessToken: 'new-at', refreshToken: 'new-rt', expiresIn: 3600 });
    const [, init] = fetchMock.mock.calls[0];
    const sent =
      init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body);
    expect(sent.grant_type).toBe('refresh_token');
    expect(sent.refresh_token).toBe('old-rt');
  });

  it('a failed refresh (non-2xx) yields null, never a fabricated credential', async () => {
    const ex = new DefaultExecutor('claude');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 400 }));
    expect(await ex.refreshCredentials({ refreshToken: 'old-rt' }, null)).toBeNull();
  });

  it('refreshWithForm keeps the old refresh token when the response omits one', async () => {
    const ex = new DefaultExecutor('openai');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'at',
          expires_in: 60,
        }),
        { status: 200 }
      )
    );
    const out = await ex.refreshWithForm('https://t.example/token', {
      grant_type: 'refresh_token',
      refresh_token: 'keep-me',
    });
    expect(out).toEqual({ accessToken: 'at', refreshToken: 'keep-me', expiresIn: 60 });
  });

  it('refreshKiro posts the JSON refresh body with the kiro-cli UA', async () => {
    const ex = new DefaultExecutor('kiro');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accessToken: 'kat',
          refreshToken: 'krt',
          expiresIn: 10,
        }),
        { status: 200 }
      )
    );
    const out = await ex.refreshCredentials({ refreshToken: 'old' }, null);
    expect(out).toEqual({ accessToken: 'kat', refreshToken: 'krt', expiresIn: 10 });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ refreshToken: 'old' });
    expect(init.headers['User-Agent']).toBe('kiro-cli/1.0.0');
  });

  it('a refresher that throws is caught and reported as null with an error log', async () => {
    const ex = new DefaultExecutor('claude');
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const log = { error: vi.fn() };
    expect(await ex.refreshCredentials({ refreshToken: 'r' }, log)).toBeNull();
    expect(log.error).toHaveBeenCalledWith('TOKEN', expect.stringContaining('network down'));
  });
});
