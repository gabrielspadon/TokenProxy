// KimchiExecutor + kimchiModels: gateway field drops (each one an upstream 400
// or silent token-cost inflation if it leaks), anthropic-backed reasoning
// strip, catalog normalization/caching, and non-2xx propagation from the
// catalog fetch. Complements kimchi-strip-reasoning (stripReasoningContent).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const KimchiExecutor = (await import('../../open-sse/executors/kimchi.js')).default;
const {
  buildKimchiModelsUrl,
  normalizeKimchiModel,
  resolveKimchiModels,
  getCachedKimchiModelMetadata,
  clearKimchiCatalog,
  KIMCHI_API,
} = await import('../../open-sse/services/kimchiModels.js');

beforeEach(() => {
  fetchMock.mockReset();
  clearKimchiCatalog();
});

describe('KimchiExecutor.buildHeaders', () => {
  it('bearer auth plus the live kimchi User-Agent', () => {
    const ex = new KimchiExecutor();
    const h = ex.buildHeaders({ accessToken: 'kt' }, true);
    expect(h['Authorization']).toBe('Bearer kt');
    expect(h['User-Agent']).toMatch(/^kimchi\//);
  });
});

describe('KimchiExecutor.transformRequest — gateway drops', () => {
  const ex = new KimchiExecutor();

  it('drops every Anthropic top-level field the OpenAI gateway rejects', () => {
    const out = ex.transformRequest(
      'some-model',
      {
        messages: [{ role: 'user', content: 'hi' }],
        anthropic_version: 'x',
        anthropic_beta: ['b'],
        client_metadata: { a: 1 },
        mcp_servers: [{}],
        stop_sequences: ['\n'],
        thinking: { type: 'enabled' },
        top_k: 40,
        max_tokens: 10,
      },
      true,
      {}
    );
    for (const key of [
      'anthropic_version',
      'anthropic_beta',
      'client_metadata',
      'mcp_servers',
      'stop_sequences',
      'thinking',
      'top_k',
      'system',
    ]) {
      expect(out[key], key).toBeUndefined();
    }
    expect(out.max_tokens).toBe(10); // billing-relevant field untouched
    expect(out.messages[0].content).toBe('hi');
  });

  it('merges a top-level system prompt into the message list instead of dropping it', () => {
    const out = ex.transformRequest(
      'm',
      {
        system: [{ type: 'text', text: 'sys A' }, 'sys B'],
        messages: [{ role: 'user', content: 'q' }],
      },
      true,
      {}
    );
    expect(out.system).toBeUndefined();
    expect(out.messages[0]).toEqual({ role: 'system', content: 'sys A\nsys B' });
    expect(out.messages[1].content).toBe('q');
  });

  it('prepends to an existing system message rather than adding a second one', () => {
    const out = ex.transformRequest(
      'm',
      {
        system: 'top',
        messages: [
          { role: 'system', content: 'existing' },
          { role: 'user', content: 'q' },
        ],
      },
      true,
      {}
    );
    expect(out.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(out.messages[0].content).toBe('top\n\nexisting');
  });

  it('strips cache_control and signature from message parts and tools', () => {
    const out = ex.transformRequest(
      'm',
      {
        messages: [
          {
            role: 'user',
            cache_control: { type: 'ephemeral' },
            content: [
              { type: 'text', text: 't', cache_control: { type: 'ephemeral' }, signature: 'sig' },
            ],
          },
        ],
        tools: [{ name: 'f', cache_control: { type: 'ephemeral' } }],
      },
      true,
      {}
    );
    expect(out.messages[0].cache_control).toBeUndefined();
    expect(out.messages[0].content[0]).toEqual({ type: 'text', text: 't' });
    expect(out.tools[0]).toEqual({ name: 'f' });
  });

  it('strips reasoning params for claude-named models (anthropic-backed), keeps them otherwise', () => {
    const claudeOut = ex.transformRequest(
      'claude-sonnet-4.6',
      {
        messages: [{ role: 'user', content: 'q' }],
        reasoning_effort: 'high',
        reasoning: { effort: 'high' },
        thinking: { type: 'enabled' },
      },
      true,
      {}
    );
    expect(claudeOut.reasoning_effort).toBeUndefined();
    expect(claudeOut.reasoning).toBeUndefined();
    expect(claudeOut.thinking).toBeUndefined();

    const otherOut = ex.transformRequest(
      'minimax-m3',
      {
        messages: [{ role: 'user', content: 'q' }],
        reasoning_effort: 'high',
      },
      true,
      {}
    );
    expect(otherOut.reasoning_effort).toBe('high');
  });

  it('strips reasoning when the cached catalog marks the model anthropic-backed by metadata, not name', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ slug: 'opus-alias', provider: 'anthropic' }],
        }),
        { status: 200 }
      )
    );
    await resolveKimchiModels({ accessToken: 'kt' });
    const out = ex.transformRequest(
      'opus-alias',
      {
        messages: [{ role: 'user', content: 'q' }],
        reasoning_effort: 'high',
      },
      true,
      {}
    );
    expect(out.reasoning_effort).toBeUndefined();
  });
});

describe('kimchiModels.buildKimchiModelsUrl', () => {
  it('defaults to the kimchi API and normalizes trailing slashes on overrides', () => {
    expect(buildKimchiModelsUrl()).toBe(`${KIMCHI_API}/v1/models/metadata?include_in_cli=true`);
    expect(buildKimchiModelsUrl('https://alt.example//')).toBe(
      'https://alt.example/v1/models/metadata?include_in_cli=true'
    );
  });
});

describe('kimchiModels.normalizeKimchiModel', () => {
  it('maps limits and modalities into capabilities, and flags anthropic compat', () => {
    const m = normalizeKimchiModel({
      slug: 'claude-x',
      display_name: 'Claude X',
      provider: 'anthropic',
      reasoning: true,
      input_modalities: ['text', 'image', 'audio'],
      limits: { context_window: 200000, max_output_tokens: 8192 },
    });
    expect(m).toMatchObject({
      id: 'claude-x',
      name: 'Claude X',
      upstreamProvider: 'anthropic',
      kind: 'imageToText',
      contextLength: 200000,
      maxOutputTokens: 8192,
      compat: { supportsReasoningEffort: false, cacheControlFormat: 'anthropic' },
    });
    expect(m.inputModalities).toEqual(['text', 'image']); // audio filtered
    expect(m.capabilities).toMatchObject({
      vision: true,
      reasoning: true,
      contextWindow: 200000,
      maxOutput: 8192,
    });
  });

  it('rejects entries without an id and tolerates junk', () => {
    expect(normalizeKimchiModel(null)).toBeNull();
    expect(normalizeKimchiModel({})).toBeNull();
    expect(normalizeKimchiModel({ slug: '  ' })).toBeNull();
  });
});

describe('kimchiModels.resolveKimchiModels — fetch, cache, errors', () => {
  const creds = { accessToken: 'kt', providerSpecificData: { userId: 'u1' } };

  it('sends the bearer token to the kimchi models endpoint and caches the catalog', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ slug: 'm1', provider: 'openai' }],
        }),
        { status: 200 }
      )
    );

    const first = await resolveKimchiModels(creds);
    expect(first.models).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(buildKimchiModelsUrl());
    expect(init.headers['Authorization']).toBe('Bearer kt');

    // Second call inside TTL: served from cache, no extra network.
    const second = await resolveKimchiModels(creds);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // forceRefresh bypasses the cache.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ slug: 'm2' }],
        }),
        { status: 200 }
      )
    );
    const third = await resolveKimchiModels(creds, { forceRefresh: true });
    expect(third.models[0].id).toBe('m2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('no token → null without any network call (fail closed, no anonymous request)', async () => {
    expect(await resolveKimchiModels({})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-2xx catalog → null, warns with the status, marks 429/5xx retryable', async () => {
    const log = { warn: vi.fn() };
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many' }));
    expect(await resolveKimchiModels(creds, { log })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith('KIMCHI_MODELS', expect.stringContaining('429'));
  });

  it('an empty or unparseable model list is not cached as success', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    expect(await resolveKimchiModels(creds)).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ nope: true }), { status: 200 }));
    expect(await resolveKimchiModels(creds, { forceRefresh: true })).toBeNull();
  });
});

describe('kimchiModels.getCachedKimchiModelMetadata', () => {
  it('resolves by id, case-insensitively, and through a provider/ prefix', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ slug: 'Kimi-K3', provider: 'moonshot' }],
        }),
        { status: 200 }
      )
    );
    await resolveKimchiModels({ accessToken: 'kt' });
    expect(getCachedKimchiModelMetadata('Kimi-K3')?.id).toBe('Kimi-K3');
    expect(getCachedKimchiModelMetadata('kimi-k3')?.id).toBe('Kimi-K3');
    expect(getCachedKimchiModelMetadata('vendor/Kimi-K3')?.id).toBe('Kimi-K3');
    expect(getCachedKimchiModelMetadata('absent')).toBeNull();
    expect(getCachedKimchiModelMetadata('')).toBeNull();
  });
});
