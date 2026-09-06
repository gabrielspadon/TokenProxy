/**
 * Contract tests for open-sse/services/provider.js: format detection,
 * target-format resolution, credential auth mode, and transport selection.
 * Expectations derive from PROVIDERS config and synthetic transports —
 * no provider-literal assertions beyond the compatible-prefix contract
 * the module itself defines.
 */
import { describe, expect, it } from 'vitest';

const { PROVIDERS } = await import('open-sse/config/providers.js');
const {
  resolveOpenAICompatibleApiType,
  detectFormat,
  getTargetFormat,
  credentialAuthMode,
  resolveTransport,
  isLastMessageFromUser,
  hasThinkingConfig,
  normalizeThinkingConfig,
} = await import('open-sse/services/provider.js');

describe('resolveOpenAICompatibleApiType', () => {
  it('stored apiType is authoritative over the node id', () => {
    const creds = { providerSpecificData: { apiType: 'chat' } };
    expect(resolveOpenAICompatibleApiType('openai-compatible-responses-x', creds)).toBe('chat');
    expect(
      resolveOpenAICompatibleApiType('openai-compatible-chat-x', {
        providerSpecificData: { apiType: 'responses' },
      })
    ).toBe('responses');
  });

  it('falls back to the id substring for legacy nodes', () => {
    expect(resolveOpenAICompatibleApiType('openai-compatible-responses-x')).toBe('responses');
    expect(resolveOpenAICompatibleApiType('openai-compatible-chat-x')).toBe('chat');
    expect(resolveOpenAICompatibleApiType(null)).toBe('chat');
  });
});

describe('detectFormat', () => {
  it('responses input (array or string) without messages', () => {
    expect(detectFormat({ input: 'hi' })).toBe('openai-responses');
    expect(detectFormat({ input: [{ role: 'user', content: 'hi' }] })).toBe('openai-responses');
    expect(detectFormat({ input: 'hi', messages: [] })).not.toBe('openai-responses');
  });

  it('antigravity wrapped gemini', () => {
    expect(detectFormat({ request: { contents: [] }, userAgent: 'antigravity' })).toBe(
      'antigravity'
    );
  });

  it('bare contents array is gemini', () => {
    expect(detectFormat({ contents: [{ role: 'user', parts: [] }] })).toBe('gemini');
  });

  it('openai-only indicator fields win before claude checks', () => {
    for (const body of [
      { stream_options: { include_usage: true } },
      { response_format: { type: 'json_object' } },
      { logprobs: false },
      { n: 1 },
      { presence_penalty: 0 },
      { user: 'u1' },
    ]) {
      expect(detectFormat(body)).toBe('openai');
    }
  });

  it('claude via system field with text-block content', () => {
    const body = {
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    expect(detectFormat(body)).toBe('claude');
  });

  it('claude vs openai image shapes', () => {
    const claudeImg = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', data: 'AA==' } },
          ],
        },
      ],
    };
    const openaiImg = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          ],
        },
      ],
    };
    expect(detectFormat(claudeImg)).toBe('claude');
    expect(detectFormat(openaiImg)).toBe('openai');
  });

  it('claude tool blocks decide when images are absent', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'r' },
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          ],
        },
      ],
    };
    expect(detectFormat(body)).toBe('claude');
  });

  it('string content with system indicator is claude, else openai default', () => {
    expect(detectFormat({ system: 's', messages: [{ role: 'user', content: 'hi' }] })).toBe(
      'claude'
    );
    expect(detectFormat({ messages: [{ role: 'user', content: 'hi' }] })).toBe('openai');
    expect(detectFormat({})).toBe('openai');
  });
});

describe('getTargetFormat', () => {
  it("matches each registered provider's own configured format", () => {
    for (const [id, cfg] of Object.entries(PROVIDERS)) {
      expect(getTargetFormat(id)).toBe(cfg.format || 'openai');
    }
  });

  it('compatible prefixes resolve by contract, unknown providers default', () => {
    expect(getTargetFormat('openai-compatible-chat-x')).toBe('openai');
    expect(getTargetFormat('openai-compatible-responses-x')).toBe('openai-responses');
    expect(getTargetFormat('anthropic-compatible-x')).toBe('claude');
    expect(getTargetFormat('no-such-provider-xyz')).toBe(PROVIDERS.openai.format || 'openai');
  });
});

describe('credentialAuthMode', () => {
  it('normalizes declared authType', () => {
    expect(credentialAuthMode({ authType: 'access_token' })).toBe('oauth');
    expect(credentialAuthMode({ authType: 'api_key' })).toBe('apikey');
    expect(credentialAuthMode({ authType: 'APIKEY' })).toBe('apikey');
    expect(credentialAuthMode({ authType: 'cookie' })).toBe('cookie');
  });

  it('shape decides when no authType is declared', () => {
    expect(credentialAuthMode({ apiKey: 'k' })).toBe('apikey');
    expect(credentialAuthMode({ apiKey: 'k', accessToken: 't' })).toBe('oauth');
    expect(credentialAuthMode({ accessToken: 't' })).toBe('oauth');
    expect(credentialAuthMode(null)).toBe('oauth');
  });
});

describe('resolveTransport', () => {
  // Synthetic provider id keeps this agnostic: config comes only from
  // credentials.providerSpecificData.transports.
  const creds = (transports, extra = {}) => ({
    providerSpecificData: { transports },
    ...extra,
  });

  it('returns null with no transports', () => {
    expect(resolveTransport('no-such-provider-xyz', 'openai', null)).toBeNull();
    expect(resolveTransport('no-such-provider-xyz', 'openai', creds([]))).toBeNull();
  });

  it('plain first-match when no transport declares authModes', () => {
    const t = [
      { format: 'claude', baseUrl: 'a' },
      { format: 'openai', baseUrl: 'b' },
    ];
    expect(resolveTransport('no-such-provider-xyz', 'openai', creds(t)).baseUrl).toBe('b');
  });

  it('credential-scoped selection among format matches', () => {
    const t = [
      { format: 'openai', baseUrl: 'sub', authModes: ['oauth'] },
      { format: 'openai', baseUrl: 'plat', authModes: ['apikey'] },
    ];
    expect(resolveTransport('x', 'openai', creds(t, { apiKey: 'k' })).baseUrl).toBe('plat');
    expect(resolveTransport('x', 'openai', creds(t, { accessToken: 't' })).baseUrl).toBe('sub');
  });

  it('falls back to the unscoped entry, then to the first match', () => {
    const withUnscoped = [
      { format: 'openai', baseUrl: 'scoped', authModes: ['cookie'] },
      { format: 'openai', baseUrl: 'open' },
    ];
    expect(resolveTransport('x', 'openai', creds(withUnscoped, { apiKey: 'k' })).baseUrl).toBe(
      'open'
    );
    const onlyScoped = [{ format: 'openai', baseUrl: 'scoped', authModes: ['cookie'] }];
    expect(resolveTransport('x', 'openai', creds(onlyScoped, { apiKey: 'k' })).baseUrl).toBe(
      'scoped'
    );
  });

  it("undeclared client format stays on the credential's endpoint (#943)", () => {
    const t = [
      { format: 'openai', baseUrl: 'sub', authModes: ['oauth'] },
      { format: 'claude', baseUrl: 'plat', authModes: ['apikey'] },
    ];
    const got = resolveTransport('x', 'openai-responses', creds(t, { apiKey: 'k' }));
    expect(got.authModes).toContain('apikey');
  });

  it('no authModes anywhere: undeclared format resolves to null (provider default)', () => {
    const t = [{ format: 'openai', baseUrl: 'b' }];
    expect(resolveTransport('x', 'openai-responses', creds(t, { apiKey: 'k' }))).toBeNull();
  });

  it('registry-configured transports resolve their own declared format', () => {
    const entry = Object.entries(PROVIDERS).find(
      ([, c]) => Array.isArray(c.transports) && c.transports.length
    );
    if (!entry) return;
    const [id, cfg] = entry;
    const fmt = cfg.transports[0].format;
    expect(resolveTransport(id, fmt, {}).format).toBe(fmt);
  });
});

describe('thinking config normalization', () => {
  it('isLastMessageFromUser reads messages or contents, empty is true', () => {
    expect(isLastMessageFromUser({})).toBe(true);
    expect(isLastMessageFromUser({ messages: [] })).toBe(true);
    expect(isLastMessageFromUser({ messages: [{ role: 'assistant' }] })).toBe(false);
    expect(isLastMessageFromUser({ contents: [{ role: 'user' }] })).toBe(true);
  });

  it('hasThinkingConfig', () => {
    expect(hasThinkingConfig({ reasoning_effort: 'high' })).toBe(true);
    expect(hasThinkingConfig({ thinking: { type: 'enabled' } })).toBe(true);
    expect(hasThinkingConfig({ thinking: { type: 'disabled' } })).toBe(false);
    expect(hasThinkingConfig({})).toBe(false);
  });

  it('normalizeThinkingConfig drops thinking only on non-user last turn', () => {
    const kept = normalizeThinkingConfig({
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(kept.thinking).toBeDefined();
    const dropped = normalizeThinkingConfig({
      thinking: { type: 'enabled' },
      messages: [{ role: 'assistant', content: 'tool turn' }],
    });
    expect(dropped.thinking).toBeUndefined();
  });
});
