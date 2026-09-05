// handleChatSearch: trust-boundary validation, provider dispatch, error
// propagation with upstream status intact, and per-provider answer extraction.
// Every extractor is fed a realistic payload plus a malformed one, because a
// throw here kills the whole /v1/search request.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleChatSearch, CHAT_SEARCH_CONFIG } from 'open-sse/handlers/search/chatSearch.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

let lastCall;
function stubFetch(payload, { ok = true, status = 200, reject = null, invalidJson = false } = {}) {
  lastCall = null;
  globalThis.fetch = vi.fn(async (url, init) => {
    lastCall = { url, init, body: JSON.parse(init.body) };
    if (reject) throw reject;
    return {
      ok,
      status,
      json: async () => {
        if (invalidJson) throw new SyntaxError('bad json');
        return payload;
      },
    };
  });
}

const creds = { apiKey: 'k' };

describe('trust-boundary validation (no fetch fired)', () => {
  it('rejects an unknown provider with 400', async () => {
    stubFetch({});
    const r = await handleChatSearch({ provider: 'nope', query: 'q', credentials: creds });
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-string query with 400', async () => {
    stubFetch({});
    expect(await handleChatSearch({ provider: 'openai', credentials: creds })).toMatchObject({
      success: false,
      status: 400,
      error: 'Missing query',
    });
    expect(
      await handleChatSearch({ provider: 'openai', query: 42, credentials: creds })
    ).toMatchObject({ success: false, status: 400 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects missing credentials with 401', async () => {
    stubFetch({});
    const r = await handleChatSearch({ provider: 'openai', query: 'q', credentials: {} });
    expect(r).toMatchObject({ success: false, status: 401 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('antigravity without a projectId is a 401 naming the reconnect, not an upstream 403', async () => {
    stubFetch({});
    const r = await handleChatSearch({
      provider: 'antigravity',
      query: 'q',
      credentials: { accessToken: 't' },
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toMatch(/projectId/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('error propagation keeps upstream status intact', () => {
  it('maps AbortError to 504', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    stubFetch({}, { reject: abortErr });
    const r = await handleChatSearch({ provider: 'openai', query: 'q', credentials: creds });
    expect(r).toMatchObject({ success: false, status: 504, error: 'Upstream timeout' });
  });

  it('maps a network error to 502 with the message', async () => {
    stubFetch({}, { reject: new Error('ECONNREFUSED') });
    const r = await handleChatSearch({ provider: 'openai', query: 'q', credentials: creds });
    expect(r).toMatchObject({ success: false, status: 502 });
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('non-JSON upstream body is 502, never a throw', async () => {
    stubFetch({}, { invalidJson: true, status: 200 });
    const r = await handleChatSearch({ provider: 'openai', query: 'q', credentials: creds });
    expect(r).toMatchObject({ success: false, status: 502 });
  });

  it('upstream 429 passes through as 429 with the upstream error message', async () => {
    stubFetch({ error: { message: 'rate limited' } }, { ok: false, status: 429 });
    const r = await handleChatSearch({ provider: 'openai', query: 'q', credentials: creds });
    expect(r).toMatchObject({ success: false, status: 429, error: 'rate limited' });
  });

  it('a non-string upstream error object is serialized, not [object Object]', async () => {
    stubFetch({ error: { code: 7 } }, { ok: false, status: 500 });
    const r = await handleChatSearch({ provider: 'openai', query: 'q', credentials: creds });
    expect(r.error).toBe(JSON.stringify({ code: 7 }));
  });
});

describe('request building and the unified success envelope', () => {
  it('openai: search-preview model gets no tools, other models get web_search; usage totals flow to llm_tokens', async () => {
    stubFetch({
      choices: [
        {
          message: {
            content: 'answer',
            annotations: [{ url_citation: { url: 'https://a.com', title: 'A' } }],
          },
        },
      ],
      usage: { total_tokens: 77 },
    });
    const r = await handleChatSearch({
      provider: 'openai',
      query: 'q',
      model: 'gpt-4o',
      credentials: creds,
    });
    expect(lastCall.body.tools).toEqual([{ type: 'web_search' }]);
    expect(r.success).toBe(true);
    expect(r.data.usage).toEqual({ queries_used: 1, search_cost_usd: 0, llm_tokens: 77 });
    expect(r.data.results[0]).toMatchObject({
      url: 'https://a.com',
      title: 'A',
      position: 1,
      citation: { provider: 'openai', rank: 1 },
    });
    expect(r.data.answer).toMatchObject({ source: 'openai', text: 'answer', model: 'gpt-4o' });

    stubFetch({ choices: [{ message: { content: 'x' } }] });
    await handleChatSearch({
      provider: 'openai',
      query: 'q',
      model: 'gpt-4o-search-preview',
      credentials: creds,
    });
    expect(lastCall.body).not.toHaveProperty('tools');
  });

  it('falls back to the registry default model when none is given', async () => {
    stubFetch({ choices: [{ message: { content: 'x' } }] });
    const r = await handleChatSearch({ provider: 'openai', query: 'q', credentials: creds });
    expect(r.data.answer.model).toBe('gpt-4o-mini');
    expect(lastCall.body.model).toBe('gpt-4o-mini');
  });

  it('maxResults caps the citation list; a bogus maxResults falls back to the default 10', async () => {
    const citations = Array.from({ length: 15 }, (_, i) => ({ url: `https://s${i}.com` }));
    stubFetch({ choices: [{ message: { content: 'x' } }], citations });
    let r = await handleChatSearch({
      provider: 'perplexity',
      query: 'q',
      maxResults: 3,
      credentials: creds,
    });
    expect(r.data.results).toHaveLength(3);
    r = await handleChatSearch({
      provider: 'perplexity',
      query: 'q',
      maxResults: -1,
      credentials: creds,
    });
    expect(r.data.results).toHaveLength(10);
    r = await handleChatSearch({
      provider: 'perplexity',
      query: 'q',
      maxResults: NaN,
      credentials: creds,
    });
    expect(r.data.results).toHaveLength(10);
  });

  it('antigravity: sends project + IDE user agent, unwraps { response }, dedupes repeated sources by URL', async () => {
    stubFetch({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: 'The sky is blue because of Rayleigh scattering. It happens at short wavelengths.',
                },
              ],
            },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://phys.org/a', title: 'Phys' } },
                { web: { uri: 'https://phys.org/a', title: 'Phys' } },
              ],
              groundingSupports: [
                {
                  segment: { startIndex: 0, endIndex: 20, text: 'The sky is blue' },
                  groundingChunkIndices: [0, 1],
                },
              ],
            },
          },
        ],
        usageMetadata: { totalTokenCount: 42 },
      },
    });
    const r = await handleChatSearch({
      provider: 'antigravity',
      query: 'why is the sky blue',
      credentials: { accessToken: 't', projectId: 'proj-1' },
    });
    expect(lastCall.body.project).toBe('proj-1');
    expect(lastCall.init.headers['User-Agent']).toMatch(/^antigravity\/ide\//);
    expect(r.data.results).toHaveLength(1);
    expect(r.data.results[0].snippet).toBe('The sky is blue');
    expect(r.data.usage.llm_tokens).toBe(42);
  });

  it('kimi: citations parsed out of $web_search tool_call arguments; malformed JSON args skipped, not thrown', async () => {
    stubFetch({
      choices: [
        {
          message: {
            content: 'found it',
            tool_calls: [
              { function: { name: '$web_search', arguments: '{not json' } },
              {
                function: {
                  name: '$web_search',
                  arguments: JSON.stringify({
                    search_results: [
                      { url: 'https://k.com', title: 'K', snippet: 's' },
                      { link: 'https://l.com' },
                      { title: 'no url, dropped' },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { total_tokens: 5 },
    });
    const r = await handleChatSearch({ provider: 'kimi', query: 'q', credentials: creds });
    expect(r.success).toBe(true);
    expect(r.data.results.map((x) => x.url)).toEqual(['https://k.com', 'https://l.com']);
  });

  it('glm: reads the side-channel web_search array with its `link` spelling', async () => {
    stubFetch({
      choices: [{ message: { content: 'ans' } }],
      web_search: [{ link: 'https://z.ai/a', title: 'T', content: 'c' }],
      usage: { total_tokens: 9 },
    });
    const r = await handleChatSearch({ provider: 'glm', query: 'q', credentials: creds });
    expect(r.data.results[0]).toMatchObject({ url: 'https://z.ai/a', snippet: 'c' });
  });

  it('xai: concatenates responses-API output text and collects annotation citations', async () => {
    stubFetch({
      output: [
        {
          content: [
            { text: 'part1 ', annotations: [{ url_citation: { url: 'https://x.com/1' } }] },
            { text: 'part2', annotations: [{ url: 'https://x.com/2' }] },
          ],
        },
      ],
      usage: { total_tokens: 3 },
    });
    const r = await handleChatSearch({ provider: 'xai', query: 'q', credentials: creds });
    expect(r.data.answer.text).toBe('part1 part2');
    expect(r.data.results.map((x) => x.url)).toEqual(['https://x.com/1', 'https://x.com/2']);
  });

  it("every provider's extractAnswer survives an empty object without throwing", () => {
    for (const [id, cfg] of Object.entries(CHAT_SEARCH_CONFIG)) {
      const out = cfg.extractAnswer({});
      expect(out, id).toMatchObject({ text: '', tokens: 0 });
      expect(Array.isArray(out.citations), id).toBe(true);
    }
  });
});
