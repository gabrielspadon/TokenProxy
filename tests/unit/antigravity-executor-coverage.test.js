// Antigravity executor coverage: buildUrl stream/image branches, parseError
// safe-message contract, image-config aspect derivation, requestId passthrough,
// functionResponse role fix + thoughtSignature backfill, retry header parsing
// (date and x-ratelimit forms), refreshCredentials token exchange (mocked),
// project/session id generators, and the static cloakTools lifecycle.
// Expectations derive from the module's own exports and appConstants — no
// provider-literal hardcoding beyond names the config itself exports.
// Zero real network: proxyAwareFetch is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
// Escape hatch for the throw-path test: a sync throw stored in vi.fn results
// is replayed by vitest 4 as an unhandled error after the test, so that one
// case bypasses the vi.fn wrapper.
const savedImpl = { current: null };
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) =>
    savedImpl.current ? savedImpl.current(...args) : fetchMock(...args),
}));

const { AntigravityExecutor } = await import('../../open-sse/executors/antigravity.js');
const { AG_TOOL_SUFFIX, AG_DEFAULT_TOOLS } = await import('../../open-sse/config/appConstants.js');
const { HTTP_STATUS } = await import('../../open-sse/config/runtimeConfig.js');
const { ANTIGRAVITY_SAFE_ERROR_MESSAGE } =
  await import('../../open-sse/services/antigravityValidation.js');
const { DEFAULT_THINKING_AG_SIGNATURE } =
  await import('../../open-sse/config/defaultThinkingSignature.js');

beforeEach(() => fetchMock.mockReset());

const ex = new AntigravityExecutor();
const [nativeToolName] = [...AG_DEFAULT_TOOLS];

describe('buildUrl', () => {
  const base = ex.getBaseUrls()[0];

  it('streams via streamGenerateContent, non-stream via generateContent', () => {
    expect(ex.buildUrl('some-model', true)).toBe(
      `${base}/v1internal:streamGenerateContent?alt=sse`
    );
    expect(ex.buildUrl('some-model', false)).toBe(`${base}/v1internal:generateContent`);
  });

  it('forces non-streaming for image models and falls back past a bad urlIndex', () => {
    expect(ex.buildUrl('anything-image', true, 99)).toBe(`${base}/v1internal:generateContent`);
  });
});

describe('parseError', () => {
  it('replaces upstream text with the safe message and attaches no validation for plain 500', () => {
    const parsed = ex.parseError({ status: 500 }, 'internal secret detail');
    expect(parsed.message).toBe(ANTIGRAVITY_SAFE_ERROR_MESSAGE);
    expect(parsed.message).not.toContain('secret');
  });

  it('tolerates unparseable JSON bodies', () => {
    const parsed = ex.parseError({ status: 400 }, '{not json');
    expect(parsed.message).toBe(ANTIGRAVITY_SAFE_ERROR_MESSAGE);
  });
});

describe('transformRequest — image models', () => {
  it('derives aspect ratio from a WxH resolution suffix and strips it from the model', () => {
    const body = { request: { contents: [{ role: 'user', parts: [{ text: 'draw' }] }] } };
    const out = ex.transformRequest('foo-image-1024x768', body, false, {});
    expect(out.model).toBe('foo-image');
    expect(out.request.generationConfig.imageConfig.aspectRatio).toBe('4:3');
    expect(out.requestType).toBe('image_gen');
  });

  it('takes a small WxH suffix as a literal aspect ratio', () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'draw' }] }] };
    const out = ex.transformRequest('foo-image-16x9', body, false, {});
    expect(out.request.generationConfig.imageConfig.aspectRatio).toBe('16:9');
  });

  it('allowlists only text and well-formed inlineData parts', () => {
    const body = {
      request: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'keep' },
              { text: '' },
              { inlineData: { mimeType: 'image/png', data: 'abc' } },
              { inlineData: { data: 'no-mime' } },
              { functionCall: { name: 'dropme' } },
              null,
            ],
          },
          { role: 'user', parts: [{ functionCall: {} }] }, // all-invalid → dropped
          'not-an-object',
        ],
      },
    };
    const out = ex.transformRequest('foo-image', body, false, {});
    expect(out.request.contents).toHaveLength(1);
    expect(out.request.contents[0].parts).toEqual([
      { text: 'keep' },
      { inlineData: { mimeType: 'image/png', data: 'abc' } },
    ]);
  });
});

describe('transformRequest — standard requests', () => {
  it('passes through a client requestId already in IDE format', () => {
    const body = { requestId: 'agent/conv/123/traj/5', request: { contents: [] } };
    const out = ex.transformRequest('m', body, true, {});
    expect(out.requestId).toBe('agent/conv/123/traj/5');
  });

  it('forces functionResponse turns to role user and backfills thoughtSignature on functionCall', () => {
    const body = {
      request: {
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 't' } }] },
          { role: 'model', parts: [{ functionResponse: { name: 't' } }] },
        ],
      },
    };
    const out = ex.transformRequest('m', body, true, {});
    const [call, resp] = out.request.contents;
    expect(call.parts[0].thoughtSignature).toBe(DEFAULT_THINKING_AG_SIGNATURE);
    expect(resp.role).toBe('user');
  });

  it('merges tool groups, sanitizes names, and defaults empty parameters', () => {
    const body = {
      request: {
        tools: [
          {
            functionDeclarations: [
              { name: 'a b!', parameters: { type: 'object', properties: {} } },
            ],
          },
          { functionDeclarations: [{ name: 'a_b_' }, { name: 'a_b_' }, { name: undefined }] },
        ],
      },
    };
    const out = ex.transformRequest('m', body, true, {});
    expect(out.request.tools).toHaveLength(1);
    const names = out.request.tools[0].functionDeclarations.map((f) => f.name);
    expect(names).toEqual(['a_b_', '_unknown']);
    // declaration without parameters gets the fallback schema
    const noParams = out.request.tools[0].functionDeclarations[1];
    expect(noParams.parameters.required).toEqual(['reason']);
    expect(out.request.toolConfig.functionCallingConfig.mode).toBe('VALIDATED');
  });
});

describe('refreshCredentials (mocked token endpoint)', () => {
  it('exchanges the refresh token and keeps the old one if none returned', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-at', expires_in: 3600 }),
    });
    const out = await ex.refreshCredentials({ refreshToken: 'rt', projectId: 'p1' }, null);
    expect(out).toEqual({
      accessToken: 'new-at',
      refreshToken: 'rt',
      expiresIn: 3600,
      projectId: 'p1',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain('grant_type=refresh_token');
  });

  it('returns null without a refresh token, on non-ok, and on fetch throw', async () => {
    expect(await ex.refreshCredentials({}, null)).toBeNull();
    fetchMock.mockResolvedValue({ ok: false });
    expect(await ex.refreshCredentials({ refreshToken: 'rt' }, null)).toBeNull();
    const log = { error: vi.fn() };
    // Plain thrower, not routed through vi.fn: vitest 4 replays an error
    // stored in a vi.fn's results as unhandled even when the caller caught it.
    savedImpl.current = () => {
      throw new Error('net down');
    };
    expect(await ex.refreshCredentials({ refreshToken: 'rt' }, log)).toBeNull();
    expect(log.error).toHaveBeenCalledWith('TOKEN', ANTIGRAVITY_SAFE_ERROR_MESSAGE);
    savedImpl.current = null;
  });
});

describe('id generators', () => {
  it('generateProjectId yields adj-noun-hex5 and generateSessionId is uuid+epoch', () => {
    expect(ex.generateProjectId()).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{5}$/);
    expect(ex.generateSessionId()).toMatch(/^[0-9a-f-]{36}\d+$/);
  });
});

describe('parseRetryHeaders', () => {
  it('parses retry-after as an HTTP date (future and past)', () => {
    const future = new Headers({ 'retry-after': new Date(Date.now() + 5000).toUTCString() });
    const ms = ex.parseRetryHeaders(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
    const past = new Headers({ 'retry-after': new Date(Date.now() - 5000).toUTCString() });
    expect(ex.parseRetryHeaders(past)).toBeNull();
  });

  it('parses x-ratelimit-reset-after seconds and x-ratelimit-reset epoch', () => {
    expect(ex.parseRetryHeaders(new Headers({ 'x-ratelimit-reset-after': '3' }))).toBe(3000);
    const epoch = Math.ceil(Date.now() / 1000) + 4;
    const ms = ex.parseRetryHeaders(new Headers({ 'x-ratelimit-reset': String(epoch) }));
    expect(ms).toBeGreaterThan(0);
    const pastEpoch = Math.floor(Date.now() / 1000) - 10;
    expect(
      ex.parseRetryHeaders(new Headers({ 'x-ratelimit-reset': String(pastEpoch) }))
    ).toBeNull();
  });

  it('returns null for header-less objects and empty headers', () => {
    expect(ex.parseRetryHeaders(null)).toBeNull();
    expect(ex.parseRetryHeaders(new Headers())).toBeNull();
  });
});

describe('computeRetryDelay', () => {
  const resp = (status, headers = {}, bodyText = '') => new Response(bodyText, { status, headers });

  it('uses body reset time when headers carry none, vetoing beyond the cap', async () => {
    const short = await ex.computeRetryDelay(
      resp(
        HTTP_STATUS.RATE_LIMITED,
        {},
        JSON.stringify({ error: { message: 'Your quota will reset after 5s' } })
      ),
      0
    );
    expect(short).toBe(5000);
    const long = await ex.computeRetryDelay(
      resp(
        HTTP_STATUS.RATE_LIMITED,
        {},
        JSON.stringify({ error: { message: 'Your quota will reset after 2h7m23s' } })
      ),
      0
    );
    expect(long).toBe(false); // beyond MAX_RETRY_AFTER_MS → veto
  });

  it('vetoes non-transient statuses with non-transient messages', async () => {
    expect(await ex.computeRetryDelay(resp(400, {}, 'bad request'), 0)).toBe(false);
  });

  it('backs off exponentially on transient statuses', async () => {
    expect(await ex.computeRetryDelay(resp(HTTP_STATUS.SERVICE_UNAVAILABLE, {}, ''), 1)).toBe(2000);
  });
});

describe('AntigravityExecutor.cloakTools', () => {
  const clientTool = { name: 'my_tool', description: 'd', parameters: { type: 'OBJECT' } };

  it('returns the body untouched when no tools are present', () => {
    const body = { request: {} };
    expect(AntigravityExecutor.cloakTools(body)).toEqual({ cloakedBody: body, toolNameMap: null });
  });

  it('suffixes client tools, preserves native names, appends deduped decoys, and maps back', () => {
    const body = {
      request: {
        tools: [
          { functionDeclarations: [clientTool, { name: nativeToolName, description: 'native' }] },
          { notDeclarations: true },
        ],
        contents: [
          {
            role: 'model',
            parts: [
              { functionCall: { name: 'my_tool', args: {} } },
              { functionCall: { name: nativeToolName } },
              { text: 'plain' },
            ],
          },
          { role: 'user', parts: [{ functionResponse: { name: 'my_tool' } }] },
          { role: 'user' }, // no parts → passthrough
        ],
      },
    };
    const { cloakedBody, toolNameMap } = AntigravityExecutor.cloakTools(body);
    const decls = cloakedBody.request.tools[0].functionDeclarations;
    const suffixed = `my_tool${AG_TOOL_SUFFIX}`;
    expect(decls[0].name).toBe(suffixed);
    expect(toolNameMap.get(suffixed)).toBe('my_tool');
    // every AG native name appears exactly once (client copy wins the dedupe)
    const names = decls.map((d) => d.name);
    for (const n of AG_DEFAULT_TOOLS) {
      expect(names.filter((x) => x === n)).toHaveLength(1);
    }
    // history renames follow the same suffix rule; native + text parts untouched
    const [modelTurn, userTurn, bare] = cloakedBody.request.contents;
    expect(modelTurn.parts[0].functionCall.name).toBe(suffixed);
    expect(modelTurn.parts[1].functionCall.name).toBe(nativeToolName);
    expect(modelTurn.parts[2]).toEqual({ text: 'plain' });
    expect(userTurn.parts[0].functionResponse.name).toBe(suffixed);
    expect(bare).toEqual({ role: 'user' });
  });

  it('github-copilot mode drops client copies of native/decoy names entirely', () => {
    const body = {
      request: {
        tools: [{ functionDeclarations: [{ name: nativeToolName }, clientTool] }],
      },
    };
    const { cloakedBody } = AntigravityExecutor.cloakTools(body, 'github-copilot');
    const names = cloakedBody.request.tools[0].functionDeclarations.map((d) => d.name);
    expect(names.filter((n) => n === nativeToolName)).toHaveLength(1);
    expect(names).toContain(`my_tool${AG_TOOL_SUFFIX}`);
  });
});
