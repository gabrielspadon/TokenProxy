// handleChatSearch: the extractors and request plumbing the main suite leaves
// dark — gemini / minimax / perplexity-agent configs, antigravity grounding
// edge cases (segment windowing, index misses), citation-shape coercion, and
// the real timeout timer. Expectations come from CHAT_SEARCH_CONFIG itself,
// never from re-typed literals.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleChatSearch, CHAT_SEARCH_CONFIG } from 'open-sse/handlers/search/chatSearch.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let lastCall;
function stubFetch(payload, { ok = true, status = 200 } = {}) {
  lastCall = null;
  globalThis.fetch = vi.fn(async (url, init) => {
    lastCall = { url, init, body: JSON.parse(init.body) };
    return { ok, status, json: async () => payload };
  });
}

const token = 'tok-abc';
const creds = { apiKey: token };

describe('gemini config', () => {
  const cfg = CHAT_SEARCH_CONFIG.gemini;

  it('sends the config-built endpoint, body and headers', async () => {
    stubFetch({ candidates: [] });
    const r = await handleChatSearch({
      provider: 'gemini',
      query: 'q',
      model: 'g-model',
      credentials: creds,
    });
    expect(r.success).toBe(true);
    expect(lastCall.url).toBe(cfg.endpoint('g-model'));
    expect(lastCall.init.headers).toEqual(cfg.buildHeaders(token));
    expect(lastCall.body).toEqual(cfg.buildBody('q', 'g-model', creds));
  });

  it('extracts text and citations, dropping chunks without a web url', () => {
    const data = {
      candidates: [
        {
          content: { parts: [{ text: 'a' }, { notText: 1 }, { text: 'b' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://x.test/1', title: 't1' } },
              { web: {} }, // no url — dropped
              { notWeb: true }, // no web — dropped
              { web: { url: 'https://x.test/2' } }, // url field, no title
            ],
          },
        },
      ],
      usageMetadata: { totalTokenCount: 7 },
    };
    const out = cfg.extractAnswer(data);
    expect(out.text).toBe('ab');
    expect(out.tokens).toBe(7);
    expect(out.citations.map((c) => c.url)).toEqual(['https://x.test/1', 'https://x.test/2']);
    expect(out.citations[1].title).toBe('');
  });

  it('survives an empty payload', () => {
    expect(cfg.extractAnswer({})).toEqual({ text: '', citations: [], tokens: 0 });
  });
});

describe('antigravity grounding edges', () => {
  const cfg = CHAT_SEARCH_CONFIG.antigravity;

  it('windows a mid-text segment with ellipses on both cut edges', () => {
    const long = 'word '.repeat(200); // 1000 chars
    const data = {
      response: {
        candidates: [
          {
            content: { parts: [{ text: long }] },
            groundingMetadata: {
              groundingChunks: [{ web: { uri: 'https://g.test/a', title: 'T' } }],
              groundingSupports: [
                {
                  segment: { startIndex: 400, endIndex: 420, text: long.slice(400, 420) },
                  groundingChunkIndices: [0],
                },
                // segment with no integer indices — expandSegment yields ""
                { segment: { text: 'orphan' }, groundingChunkIndices: [0] },
              ],
            },
          },
        ],
        usageMetadata: { totalTokenCount: 3 },
      },
    };
    const out = cfg.extractAnswer(data);
    expect(out.citations).toHaveLength(1);
    const c = out.citations[0];
    // Both edges were cut inside the text, so both carry the ellipsis marker.
    expect(c.content.startsWith('...')).toBe(true);
    expect(c.content.includes('...')).toBe(true);
    expect(c.snippet).toContain('orphan');
    expect(out.tokens).toBe(3);
  });

  it('skips chunks without urls and supports pointing at missing indices', () => {
    const data = {
      candidates: [
        {
          content: { parts: [{ text: 'answer text here' }] },
          groundingMetadata: {
            groundingChunks: [{ web: {} }, { web: { uri: 'https://g.test/b' } }],
            groundingSupports: [
              {
                segment: { startIndex: 0, endIndex: 6, text: 'answer' },
                groundingChunkIndices: [0, 99, 'x', 1],
              },
            ],
          },
        },
      ],
    };
    const out = cfg.extractAnswer(data);
    // Only the chunk with a url survives; index 0 (no url), 99 and 'x' are skipped.
    expect(out.citations.map((c) => c.url)).toEqual(['https://g.test/b']);
  });
});

describe('openai fallback citations', () => {
  it('falls back to top-level citations when no annotations exist, coercing shapes', () => {
    const out = CHAT_SEARCH_CONFIG.openai.extractAnswer({
      choices: [{ message: { content: 'hi' } }],
      citations: [
        'https://o.test/1',
        { url: 'https://o.test/2', title: 't' },
        null,
        42,
        { noUrl: 1 },
      ],
    });
    expect(out.citations.map((c) => c.url)).toEqual(['https://o.test/1', 'https://o.test/2']);
  });
});

describe('kimi tool-call edges', () => {
  it('skips calls without arguments', () => {
    const out = CHAT_SEARCH_CONFIG.kimi.extractAnswer({
      choices: [{ message: { content: 'x', tool_calls: [{ function: {} }, null] } }],
    });
    expect(out.citations).toEqual([]);
  });
});

describe('minimax config', () => {
  const cfg = CHAT_SEARCH_CONFIG.minimax;

  it('builds the request from its own config', async () => {
    stubFetch({ choices: [] });
    const r = await handleChatSearch({
      provider: 'minimax',
      query: 'q',
      model: 'mm',
      credentials: creds,
    });
    expect(r.success).toBe(true);
    expect(lastCall.url).toBe(cfg.endpoint('mm'));
    expect(lastCall.init.headers).toEqual(cfg.buildHeaders(token));
    expect(lastCall.body).toEqual(cfg.buildBody('q', 'mm', creds));
  });

  it('prefers direct web_search_results and skips entries without urls', () => {
    const out = cfg.extractAnswer({
      choices: [{ message: { content: 'a' } }],
      web_search_results: [
        { url: 'https://m.test/1', title: 't', snippet: 's' },
        { link: 'https://m.test/2', summary: 'sum' },
        { noUrl: true },
      ],
    });
    expect(out.citations.map((c) => c.url)).toEqual(['https://m.test/1', 'https://m.test/2']);
    expect(out.citations[1].snippet).toBe('sum');
  });

  it('falls back to tool_calls, tolerating bad JSON and url-less items', () => {
    const out = cfg.extractAnswer({
      choices: [
        {
          message: {
            content: 'a',
            tool_calls: [
              { function: { arguments: 'not-json{' } },
              { function: {} },
              {
                function: {
                  arguments: JSON.stringify({
                    results: [
                      { url: 'https://m.test/3' },
                      { nope: 1 },
                      { link: 'https://m.test/4' },
                    ],
                  }),
                },
              },
              { function: { arguments: { search_results: [{ url: 'https://m.test/5' }] } } },
            ],
          },
        },
      ],
      usage: { total_tokens: 9 },
    });
    expect(out.citations.map((c) => c.url)).toEqual([
      'https://m.test/3',
      'https://m.test/4',
      'https://m.test/5',
    ]);
    expect(out.tokens).toBe(9);
  });
});

describe('perplexity citation coercion', () => {
  it('coerces strings and objects, drops the rest', () => {
    const out = CHAT_SEARCH_CONFIG.perplexity.extractAnswer({
      choices: [{ message: { content: 'p' } }],
      citations: ['https://p.test/1', { url: 'https://p.test/2' }, undefined, 7],
    });
    expect(out.citations.map((c) => c.url)).toEqual(['https://p.test/1', 'https://p.test/2']);
  });
});

describe('perplexity-agent config', () => {
  const cfg = CHAT_SEARCH_CONFIG['perplexity-agent'];

  it('builds the request from its own config', async () => {
    stubFetch({ output: [] });
    const r = await handleChatSearch({
      provider: 'perplexity-agent',
      query: 'q',
      model: 'pa',
      credentials: creds,
    });
    expect(r.success).toBe(true);
    expect(lastCall.url).toBe(cfg.endpoint('pa'));
    expect(lastCall.init.headers).toEqual(cfg.buildHeaders(token));
    expect(lastCall.body).toEqual(cfg.buildBody('q', 'pa', creds));
  });

  it('collects text, annotation citations and result items from output blocks', () => {
    const out = cfg.extractAnswer({
      output: [
        {
          content: [
            {
              text: 'ans',
              annotations: [
                { url: 'https://pa.test/1' },
                { url_citation: { url: 'https://pa.test/2' } },
                { neither: 1 },
              ],
            },
            { notText: true },
          ],
          results: [
            { url: 'https://pa.test/3', title: 'r' },
            { link: 'https://pa.test/4' },
            { none: 1 },
          ],
        },
      ],
      usage: { total_tokens: 4 },
    });
    expect(out.text).toBe('ans');
    expect(out.citations.map((c) => c.url)).toEqual([
      'https://pa.test/1',
      'https://pa.test/2',
      'https://pa.test/3',
      'https://pa.test/4',
    ]);
    expect(out.tokens).toBe(4);
  });

  it('falls back to top-level citations when output carried none', () => {
    const out = cfg.extractAnswer({ output: [], citations: ['https://pa.test/9', null] });
    expect(out.citations.map((c) => c.url)).toEqual(['https://pa.test/9']);
  });
});

describe('the request timeout timer actually fires', () => {
  it('aborts a hung upstream and answers 504', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          );
        })
    );
    const pending = handleChatSearch({ provider: 'openai', query: 'q', credentials: creds });
    await vi.advanceTimersByTimeAsync(120_000);
    const r = await pending;
    expect(r).toMatchObject({ success: false, status: 504, error: 'Upstream timeout' });
  });
});
