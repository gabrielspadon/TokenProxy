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
// ── Added contracts: uncovered branches ──────────────────────────────────────
// Everything below derives its expectations from the exported registry
// (PROVIDERS / PROVIDER_OAUTH / OAUTH_ENDPOINTS) rather than provider strings,
// so a registry edit moves the fixture instead of breaking the test.
const { PROVIDERS } = await import('../../open-sse/config/providers.js');
const { OAUTH_ENDPOINTS } = await import('../../open-sse/config/appConstants.js');
const { ANTHROPIC_COMPAT_BASE } = await import('../../open-sse/providers/shared.js');

describe('applyEndpointOverride — degenerate registry URL', () => {
  it('an empty registry URL leaves the trimmed stored base standing alone', () => {
    expect(applyEndpointOverride('https://gw.example/', '')).toBe('https://gw.example');
  });
});

describe('DefaultExecutor.execute — floor probe never costs a second call on an unreadable body', () => {
  it('a non-OK response whose body cannot be re-read is returned as-is, one upstream call', async () => {
    const refusal = new Response('gone', { status: 500 });
    refusal.clone = () => ({
      text: () => Promise.reject(new Error('body consumed')),
    });
    fetchMock.mockResolvedValueOnce(refusal);
    const out = await new DefaultExecutor('openai-compatible-test').execute({
      model: 'm',
      body: { messages: [], max_tokens: 1 },
      stream: false,
      credentials: {
        apiKey: 'k',
        providerSpecificData: { baseUrl: 'https://chat.example/v1' },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(500);
  });
});

describe('DefaultExecutor.transformRequest — overlong tool-call IDs (official OpenAI)', () => {
  const ex = new DefaultExecutor('openai');
  const longId = `toolcall_${'a'.repeat(70)}`;

  it('normalizes an over-64-char id identically on the call and its tool result', () => {
    const out = ex.transformRequest(
      'gpt-4.1',
      {
        messages: [
          { role: 'assistant', tool_calls: [{ id: longId, type: 'function' }] },
          { role: 'tool', tool_call_id: longId, content: 'ok' },
        ],
      },
      true,
      {}
    );
    const callId = out.messages[0].tool_calls[0].id;
    expect(callId).not.toBe(longId);
    expect(callId.length).toBeLessThanOrEqual(64);
    // The assistant call and its tool result must keep the same relationship.
    expect(out.messages[1].tool_call_id).toBe(callId);
  });

  it('leaves an id at or under the limit untouched', () => {
    const shortId = 'call_ok';
    const out = ex.transformRequest(
      'gpt-4.1',
      {
        messages: [{ role: 'tool', tool_call_id: shortId, content: 'ok' }],
      },
      true,
      {}
    );
    expect(out.messages[0].tool_call_id).toBe(shortId);
  });
});

describe('DefaultExecutor.transformRequest — cloudflare-ai max_tokens default (#1645)', () => {
  const ex = new DefaultExecutor('cloudflare-ai');
  it('fills a positive default when the client omits max_tokens, and never overrides an explicit one', () => {
    const filled = ex.transformRequest('m', { messages: [] }, true, {});
    expect(typeof filled.max_tokens).toBe('number');
    expect(filled.max_tokens).toBeGreaterThan(0);
    const explicit = ex.transformRequest('m', { messages: [], max_tokens: 10 }, true, {});
    expect(explicit.max_tokens).toBe(10);
  });
});

describe('DefaultExecutor.applyJsonSchemaFallback — openai-compatible without Structured Output', () => {
  const ex = new DefaultExecutor('openai-compatible-x');
  const schemaBody = (messages = []) => ({
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { schema: { type: 'object', required: ['zz_marker'] } },
    },
  });

  it('downgrades json_schema to json_object and injects the schema as a system prompt', () => {
    const out = ex.transformRequest('m', schemaBody(), true, {});
    expect(out.response_format).toEqual({ type: 'json_object' });
    expect(out.messages[0].role).toBe('system');
    expect(out.messages[0].content).toContain('zz_marker');
  });

  it('appends to an existing string system message instead of adding a second one', () => {
    const out = ex.transformRequest(
      'm',
      schemaBody([{ role: 'system', content: 'base rules' }]),
      true,
      {}
    );
    expect(out.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(out.messages[0].content).toContain('base rules');
    expect(out.messages[0].content).toContain('zz_marker');
  });

  it('pushes a text part onto an array system content', () => {
    const out = ex.transformRequest(
      'm',
      schemaBody([{ role: 'system', content: [{ type: 'text', text: 'base' }] }]),
      true,
      {}
    );
    const parts = out.messages[0].content;
    expect(parts.at(-1).text).toContain('zz_marker');
  });

  it('leaves a non-json_schema response_format alone', () => {
    const body = { messages: [], response_format: { type: 'json_object' } };
    const out = ex.transformRequest('m', body, true, {});
    expect(out.response_format).toEqual({ type: 'json_object' });
  });
});

describe('DefaultExecutor.buildUrl — remaining branches', () => {
  it('anthropic-compatible: /messages appended to the stored base, default base without one', () => {
    const ex = new DefaultExecutor('anthropic-compatible-x');
    expect(
      ex.buildUrl('m', true, 0, {
        providerSpecificData: { baseUrl: 'https://a.example/v1/' },
      })
    ).toBe('https://a.example/v1/messages');
    expect(ex.buildUrl('m', true, 0, {})).toBe(`${ANTHROPIC_COMPAT_BASE}/messages`);
  });

  it('a registry urlSuffix is appended to the provider base URL', () => {
    const entry = Object.entries(PROVIDERS).find(
      ([, c]) =>
        c.urlSuffix &&
        c.baseUrl &&
        !String(c.baseUrl).includes('{accountId}') &&
        c.format !== 'gemini'
    );
    expect(entry).toBeTruthy();
    const [id, cfg] = entry;
    expect(new DefaultExecutor(id).buildUrl('m', false, 0, {})).toBe(
      `${cfg.baseUrl}${cfg.urlSuffix}`
    );
  });
});

describe('DefaultExecutor.buildHeaders — registry-declared hooks run before auth', () => {
  const providerWithHook = (hook) =>
    Object.entries(PROVIDERS).find(([, c]) => c.auth?.hooks?.includes(hook))?.[0];

  it('kimiHeaders: device id carried from the connection, auth token not clobbered', () => {
    const id = providerWithHook('kimiHeaders');
    expect(id).toBeTruthy();
    const cfg = PROVIDERS[id];
    const h = new DefaultExecutor(id).buildHeaders(
      { apiKey: 'k-tok', providerSpecificData: { deviceId: 'dev-42' } },
      true
    );
    expect(h['X-Msh-Device-Id']).toBe('dev-42');
    const expected = cfg.auth.scheme === 'bearer' ? 'Bearer k-tok' : 'k-tok';
    expect(h[cfg.auth.header]).toBe(expected);
  });

  it('clineHeaders: a plain API key rides Authorization without the session-token prefix (#2333)', () => {
    const id = providerWithHook('clineHeaders');
    expect(id).toBeTruthy();
    const h = new DefaultExecutor(id).buildHeaders({ apiKey: 'plain-key' }, true);
    expect(h['Authorization']).toBe('Bearer plain-key');
  });

  it('kilocodeOrg: org header only when the connection carries an orgId', () => {
    const id = providerWithHook('kilocodeOrg');
    expect(id).toBeTruthy();
    const withOrg = new DefaultExecutor(id).buildHeaders(
      { apiKey: 'k', providerSpecificData: { orgId: 'org-7' } },
      true
    );
    expect(withOrg['X-Kilocode-OrganizationID']).toBe('org-7');
    const without = new DefaultExecutor(id).buildHeaders({ apiKey: 'k' }, true);
    expect(without['X-Kilocode-OrganizationID']).toBeUndefined();
  });
});

describe('DefaultExecutor.buildHeaders — runtimeTransport auth descriptor', () => {
  it('combined descriptor with anthropicVersion sets both token header and version', () => {
    const ex = new DefaultExecutor('openai');
    const h = ex.buildHeaders(
      {
        apiKey: 'k',
        runtimeTransport: {
          auth: {
            combined: true,
            header: 'x-api-key',
            scheme: 'raw',
            anthropicVersion: true,
          },
        },
      },
      true
    );
    expect(h['x-api-key']).toBe('k');
    expect(h['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
  });

  it('a transport beta header reduced to only the claude-code flag is deleted, not left empty', () => {
    const ex = new DefaultExecutor('anthropic-compatible-x');
    const creds = {
      apiKey: 'k',
      providerSpecificData: { baseUrl: 'https://third.example/v1' },
      runtimeTransport: {
        headers: { 'anthropic-beta': 'claude-code-20250219' },
      },
    };
    const h = ex.buildHeaders(creds, true, undefined, 'claude-sonnet-4.6');
    expect(h['anthropic-beta']).toBeUndefined();
    const mixed = ex.buildHeaders(
      {
        ...creds,
        runtimeTransport: {
          headers: { 'anthropic-beta': 'claude-code-20250219,keep-me' },
        },
      },
      true,
      undefined,
      'claude-sonnet-4.6'
    );
    expect(mixed['anthropic-beta']).toBe('keep-me');
  });
});

describe('DefaultExecutor.refreshCredentials — provider-specific refreshers', () => {
  it('iflow: Basic auth from registry clientId:clientSecret, token response mapped', async () => {
    const cfg = PROVIDERS.iflow;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'iat', expires_in: 60 }), {
        status: 200,
      })
    );
    const out = await new DefaultExecutor('iflow').refreshCredentials(
      { refreshToken: 'irt' },
      null
    );
    expect(out).toEqual({
      accessToken: 'iat',
      refreshToken: 'irt',
      expiresIn: 60,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OAUTH_ENDPOINTS.iflow.token);
    expect(init.headers['Authorization']).toBe(
      `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`
    );
    expect(Object.fromEntries(init.body).refresh_token).toBe('irt');
  });

  it('kimi: posts the form grant to the registry refreshUrl with the stable device id', async () => {
    const cfg = PROVIDERS.kimi || PROVIDERS['kimi-coding'];
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'kat',
          refresh_token: 'krt2',
          expires_in: 5,
        }),
        { status: 200 }
      )
    );
    const out = await new DefaultExecutor('kimi').refreshCredentials(
      { refreshToken: 'krt', providerSpecificData: { deviceId: 'dev-9' } },
      null
    );
    expect(out).toEqual({
      accessToken: 'kat',
      refreshToken: 'krt2',
      expiresIn: 5,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(cfg.refreshUrl);
    expect(init.headers['X-Msh-Device-Id']).toBe('dev-9');
    const sent = Object.fromEntries(init.body);
    expect(sent.client_id).toBe(cfg.clientId);
    expect(sent.grant_type).toBe('refresh_token');
  });

  it('cline: routes through the shared refresher and returns the workos-prefixed token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { accessToken: 'cat', refreshToken: 'crt2' } }), {
        status: 200,
      })
    );
    const out = await new DefaultExecutor('cline').refreshCredentials(
      { refreshToken: 'crt' },
      null
    );
    expect(out.accessToken).toContain('cat');
    expect(out.refreshToken).toBe('crt2');
    expect(fetchMock.mock.calls[0][0]).toBe(PROVIDERS.cline.refreshUrl);
  });

  it('kilocode: device-code flow has no refresh, returns null without any call', async () => {
    expect(
      await new DefaultExecutor('kilocode').refreshCredentials({ refreshToken: 'r' }, null)
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-2xx from a provider-specific refresher yields null (iflow, kimi)', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }));
    expect(
      await new DefaultExecutor('iflow').refreshCredentials({ refreshToken: 'r' }, null)
    ).toBeNull();
    expect(
      await new DefaultExecutor('kimi').refreshCredentials({ refreshToken: 'r' }, null)
    ).toBeNull();
  });
});

// ── Added contracts: floor retry, provider-scoped normalizations, refreshers ──
const { PROVIDER_OAUTH } = await import('../../open-sse/config/providers.js');

describe('DefaultExecutor.execute — max_tokens floor retry (#1702)', () => {
  const creds = { apiKey: 'k', providerSpecificData: { baseUrl: 'https://chat.example/v1' } };

  it('an OK response returns as-is with a single upstream call', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const out = await new DefaultExecutor('openai-compatible-flr').execute({
      model: 'm',
      body: { messages: [], max_tokens: 1 },
      stream: false,
      credentials: creds,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(200);
  });

  it('a refusal naming a floor triggers exactly one retry at that floor', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'max_tokens must be greater than 2' } }), {
          status: 400,
        })
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const out = await new DefaultExecutor('openai-compatible-flr').execute({
      model: 'm',
      body: { messages: [], max_tokens: 1 },
      stream: false,
      credentials: creds,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // "greater than 2" → floor is 3, not 2.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(3);
    expect(out.response.status).toBe(200);
  });

  it('a request that sent no numeric max_tokens never retries on a refusal', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('max_tokens must be at least 16', { status: 400 })
    );
    const out = await new DefaultExecutor('openai-compatible-flr').execute({
      model: 'm',
      body: { messages: [] },
      stream: false,
      credentials: creds,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(400);
  });
});

describe('DefaultExecutor.transformRequest — remaining provider scopes', () => {
  it('openai: a body without a messages array passes the tool-call id normalizer untouched', () => {
    const ex = new DefaultExecutor('openai');
    const out = ex.transformRequest('gpt-4.1', { prompt: 'x' }, true, {});
    expect(out.prompt).toBe('x');
  });

  it('gpt-5.6 chat models that reject tools+reasoning get reasoning_effort none, others keep it', () => {
    const ex = new DefaultExecutor('openai');
    const tools = [{ type: 'function', function: { name: 'f' } }];
    const hit = ex.transformRequest(
      'gpt-5.6-luna',
      { messages: [], tools, reasoning_effort: 'high' },
      true,
      {}
    );
    expect(hit.reasoning_effort).toBe('none');
    // Responses-format source is exempt.
    const responses = ex.transformRequest(
      'gpt-5.6-luna',
      { messages: [], tools, reasoning_effort: 'high' },
      true,
      {},
      'openai-responses'
    );
    expect(responses.reasoning_effort).toBe('high');
    // Non-function tools are exempt.
    const nonFn = ex.transformRequest(
      'gpt-5.6-luna',
      { messages: [], tools: [{ type: 'web_search' }], reasoning_effort: 'high' },
      true,
      {}
    );
    expect(nonFn.reasoning_effort).toBe('high');
  });

  it("mistral: final assistant message is marked prefix:true without mutating the caller's body", () => {
    const ex = new DefaultExecutor('mistral');
    const original = {
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'pre' },
      ],
    };
    const out = ex.transformRequest('mistral-large', original, true, {});
    expect(out.messages.at(-1).prefix).toBe(true);
    // Combo fallbacks reuse the body across providers: the input must stay isolated.
    expect(original.messages.at(-1).prefix).toBeUndefined();
  });

  it('muse-spark models: a forced tool_choice is demoted to auto, with and without an effort suffix', () => {
    const ex = new DefaultExecutor('openai-compatible-x');
    const forced = ex.transformRequest(
      'muse-spark-1 (high)',
      { messages: [], tool_choice: 'required' },
      true,
      {}
    );
    expect(forced.tool_choice).toBe('auto');
    const bare = ex.transformRequest(
      'muse-spark-1',
      { messages: [], tool_choice: { type: 'function' } },
      true,
      {}
    );
    expect(bare.tool_choice).toBe('auto');
  });

  it('openai-compatible responses transport: text object without format gets the API default', () => {
    const ex = new DefaultExecutor('openai-compatible-responses-x');
    const out = ex.transformRequest('m', { messages: [], text: { verbosity: 'low' } }, true, {});
    expect(out.text).toEqual({ verbosity: 'low', format: { type: 'text' } });
    // An explicit format and a non-object text are both left alone.
    const explicit = ex.transformRequest(
      'm',
      { messages: [], text: { format: { type: 'json' } } },
      true,
      {}
    );
    expect(explicit.text.format).toEqual({ type: 'json' });
    const arr = ex.transformRequest('m', { messages: [], text: ['x'] }, true, {});
    expect(arr.text).toEqual(['x']);
  });
});

describe('DefaultExecutor.buildHeaders — split descriptor OAuth branch', () => {
  it('anthropic-compatible with only an access token authenticates via Bearer, not x-api-key', () => {
    const ex = new DefaultExecutor('anthropic-compatible-y');
    const h = ex.buildHeaders({ accessToken: 'at-1' }, true, undefined, 'claude-sonnet-4.6');
    expect(h['Authorization']).toBe('Bearer at-1');
    expect(h['x-api-key']).toBeUndefined();
    expect(h['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
  });
});

describe('DefaultExecutor.refreshCredentials — remaining grant rows', () => {
  const grantBody = (init) =>
    init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body);

  for (const provider of ['codex', 'gemini']) {
    it(`${provider}: registry grant posts refresh_token, or fails closed without one`, async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt2', expires_in: 7 }), {
          status: 200,
        })
      );
      const ex = new DefaultExecutor(provider);
      const out = await ex.refreshCredentials({ refreshToken: 'rt1' }, null);
      if (!PROVIDER_OAUTH[provider]?.refresh) {
        // No registry grant row: the refresher throws internally, the catch
        // reports null, and no upstream call carries a broken grant.
        expect(out).toBeNull();
        return;
      }
      expect(out).toEqual({ accessToken: 'at', refreshToken: 'rt2', expiresIn: 7 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(PROVIDER_OAUTH[provider].tokenUrl);
      const sent = grantBody(init);
      expect(sent.grant_type).toBe('refresh_token');
      expect(sent.refresh_token).toBe('rt1');
      const expectedClientId =
        provider === 'gemini' ? ex.config.clientId : PROVIDER_OAUTH[provider].clientId;
      expect(sent.client_id).toBe(expectedClientId);
    });
  }

  for (const provider of ['clinepass', 'kimi-coding']) {
    it(`${provider}: shares its sibling's refresher and maps the token response`, async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            provider === 'clinepass'
              ? { data: { accessToken: 'cat', refreshToken: 'crt2' } }
              : { access_token: 'kat', refresh_token: 'krt2', expires_in: 5 }
          ),
          { status: 200 }
        )
      );
      const out = await new DefaultExecutor(provider).refreshCredentials(
        { refreshToken: 'r1', providerSpecificData: { deviceId: 'd' } },
        null
      );
      expect(out).toBeTruthy();
      expect(out.refreshToken).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it('refreshWithForm and refreshKiro return null on a non-2xx without fabricating credentials', async () => {
    const ex = new DefaultExecutor('openai');
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 400 }));
    expect(await ex.refreshWithForm('https://t.example/token', { refresh_token: 'r' })).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 400 }));
    expect(await new DefaultExecutor('kiro').refreshKiro('r')).toBeNull();
  });
});
