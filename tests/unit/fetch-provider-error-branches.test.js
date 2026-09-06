// Coverage for the fetch handler's untested provider branches: tavily/exa
// dispatch, transport failures, response parsing fallbacks, and the ollama
// bounded-body edge paths. All network mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFetchCore } from '../../open-sse/handlers/fetch/index.js';

const OLLAMA_CONFIG = Object.freeze({
  formats: ['markdown'],
  maxCharacters: 200000,
  timeoutMs: 30000,
});
const TARGET = 'https://example.com/page';
const API_KEY = 'unit_test_key';
const originalFetch = globalThis.fetch;

function jsonResponse(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries({ 'content-type': 'application/json', ...headers })),
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('generic dispatch guards', () => {
  it('rejects a missing url', async () => {
    const res = await handleFetchCore({ provider: 'tavily' });
    expect(res).toMatchObject({ success: false, status: 400, error: 'url is required' });
  });

  it('rejects a missing provider', async () => {
    const res = await handleFetchCore({ url: TARGET });
    expect(res).toMatchObject({ success: false, status: 400, error: 'provider is required' });
  });

  it('rejects an unsupported provider', async () => {
    const res = await handleFetchCore({ url: TARGET, provider: 'nonesuch' });
    expect(res).toMatchObject({ success: false, status: 400 });
    expect(res.error).toContain('nonesuch');
  });

  it('maps a thrown provider error to a 502 and logs it', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/plain']]),
      text: () => Promise.reject(new Error('boom mid-read')),
    });
    const log = vi.fn();
    const res = await handleFetchCore({ url: TARGET, provider: 'tavily', log });
    expect(res).toMatchObject({ success: false, status: 502, error: 'boom mid-read' });
    expect(log).toHaveBeenCalled();
  });
});

describe('tavily provider', () => {
  it('returns normalized data and truncates to maxCharacters', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ results: [{ raw_content: 'abcdefghij' }] }));
    const res = await handleFetchCore({
      url: TARGET,
      provider: 'tavily',
      maxCharacters: 4,
      credentials: { apiKey: API_KEY },
    });
    expect(res.success).toBe(true);
    expect(res.data.provider).toBe('tavily');
    expect(res.data.content.text).toBe('abcd');
    const [calledUrl, init] = globalThis.fetch.mock.calls[0];
    expect(calledUrl).toContain('tavily');
    expect(init.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('maps a timeout abort to 504', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const res = await handleFetchCore({ url: TARGET, provider: 'tavily' });
    expect(res).toMatchObject({ success: false, status: 504 });
  });

  it('propagates an upstream error status and message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'quota' }, 429));
    const res = await handleFetchCore({ url: TARGET, provider: 'tavily' });
    expect(res).toMatchObject({ success: false, status: 429, error: 'quota' });
  });

  it('handles an empty results array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const res = await handleFetchCore({ url: TARGET, provider: 'tavily' });
    expect(res.success).toBe(true);
    expect(res.data.content.text).toBe('');
  });
});

describe('exa provider', () => {
  it('returns normalized data with title and x-api-key header', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ results: [{ text: 'hello world', title: 'T' }] }));
    const res = await handleFetchCore({
      url: TARGET,
      provider: 'exa',
      credentials: { key: API_KEY },
    });
    expect(res.success).toBe(true);
    expect(res.data.provider).toBe('exa');
    expect(res.data.title).toBe('T');
    expect(globalThis.fetch.mock.calls[0][1].headers['x-api-key']).toBe(API_KEY);
  });

  it('maps a transport failure to 502', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await handleFetchCore({ url: TARGET, provider: 'exa' });
    expect(res).toMatchObject({ success: false, status: 502, error: 'ECONNREFUSED' });
  });

  it('propagates upstream error with fallback message on non-json body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Map([['content-type', 'text/html']]),
      text: () => Promise.resolve('<html>err</html>'),
    });
    const res = await handleFetchCore({ url: TARGET, provider: 'exa' });
    expect(res).toMatchObject({ success: false, status: 500 });
    expect(res.error).toContain('500');
  });
});

describe('jina-reader branches', () => {
  it('maps a transport failure to 502', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('reset'));
    const res = await handleFetchCore({ url: TARGET, provider: 'jina-reader' });
    expect(res).toMatchObject({ success: false, status: 502, error: 'reset' });
  });

  it('parses a markdown heading as the title when no Title: line exists', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/plain']]),
      text: () => Promise.resolve('# Heading Title\n\nbody text'),
    });
    const res = await handleFetchCore({ url: TARGET, provider: 'jina-reader' });
    expect(res.success).toBe(true);
    expect(res.data.title).toBe('Heading Title');
  });

  it('returns a null title when neither metadata nor heading is present', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/plain']]),
      text: () => Promise.resolve('plain body only'),
    });
    const res = await handleFetchCore({ url: TARGET, provider: 'jina-reader' });
    expect(res.success).toBe(true);
    expect(res.data.title).toBeNull();
  });
});

describe('ollama bounded-body edge paths', () => {
  function ollamaParams(transport, overrides = {}) {
    return {
      url: TARGET,
      provider: 'ollama',
      providerConfig: OLLAMA_CONFIG,
      credentials: { apiKey: API_KEY },
      transport,
      ...overrides,
    };
  }

  it('rejects a success body whose content-length exceeds the cap', async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(64 * 1024 * 1024),
        },
      })
    );
    const res = await handleFetchCore(ollamaParams(transport));
    expect(res).toMatchObject({ success: false, status: 502, code: 'OLLAMA_RESPONSE_TOO_LARGE' });
  });

  it('truncates an oversized error body and keeps the generic message', async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response('ignored', {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'content-length': String(64 * 1024 * 1024),
        },
      })
    );
    const res = await handleFetchCore(ollamaParams(transport));
    expect(res).toMatchObject({ success: false, status: 503, code: 'OLLAMA_UPSTREAM_ERROR' });
    expect(res.error).toContain('HTTP 503');
  });

  it('treats a bodyless response as invalid JSON', async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const res = await handleFetchCore(ollamaParams(transport));
    expect(res).toMatchObject({ success: false, status: 502, code: 'OLLAMA_INVALID_JSON' });
  });

  it('classifies a synchronously-throwing body reader as a transport error', async () => {
    const transport = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => ({
          read() {
            throw new Error('reader exploded');
          },
          cancel: () => Promise.resolve(),
          releaseLock: () => {},
        }),
      },
    });
    const res = await handleFetchCore(ollamaParams(transport));
    expect(res).toMatchObject({ success: false, status: 502, code: 'OLLAMA_TRANSPORT_ERROR' });
  });

  it('rejects a JSON array payload as an invalid response', async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([1, 2]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const res = await handleFetchCore(ollamaParams(transport));
    expect(res).toMatchObject({ success: false, status: 502, code: 'OLLAMA_INVALID_RESPONSE' });
  });

  it('rejects a links entry that is not a parseable URL', async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'T',
          content: 'C',
          links: ['not a url'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const res = await handleFetchCore(ollamaParams(transport));
    expect(res).toMatchObject({ success: false, status: 502, code: 'OLLAMA_INVALID_RESPONSE' });
  });

  it('classifies a caller abort fired during transport dispatch as client-aborted', async () => {
    const controller = new AbortController();
    const late = new Response(JSON.stringify({ title: 'T', content: 'C' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const transport = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve(late);
    });
    const res = await handleFetchCore(ollamaParams(transport, { signal: controller.signal }));
    expect(res).toMatchObject({ success: false, status: 499, code: 'OLLAMA_CLIENT_ABORTED' });
  });
});
