/**
 * Orchestrator-path coverage for handleImageGenerationCore.
 * The adapter registry and executor registry are mocked so every branch of the
 * core (executor delegation, refresh-on-401, binary output, parse overrides)
 * is exercised through a controllable fake adapter. All network is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../open-sse/handlers/imageProviders/index.js', () => ({
  getImageAdapter: vi.fn(),
}));
vi.mock('../../open-sse/executors/index.js', () => ({
  getExecutor: vi.fn(),
}));
vi.mock('../../open-sse/services/tokenRefresh.js', () => ({
  refreshWithRetry: vi.fn(),
}));

import { handleImageGenerationCore } from '../../open-sse/handlers/imageGenerationCore.js';
import { getImageAdapter } from '../../open-sse/handlers/imageProviders/index.js';
import { getExecutor } from '../../open-sse/executors/index.js';
import { refreshWithRetry } from '../../open-sse/services/tokenRefresh.js';

const originalFetch = global.fetch;
const PNG_B64 = Buffer.from('fake-image-bytes').toString('base64');

function baseAdapter(overrides = {}) {
  return {
    buildUrl: vi.fn(() => 'https://upstream.invalid/images'),
    buildHeaders: vi.fn((creds) => ({ Authorization: `Bearer ${creds?.apiKey || ''}` })),
    buildBody: vi.fn((model, body) => ({ model, prompt: body.prompt })),
    normalize: vi.fn((parsed) => parsed),
    ...overrides,
  };
}

function call(opts = {}) {
  return handleImageGenerationCore({
    body: { prompt: 'a boat' },
    modelInfo: { provider: 'fakeprov', model: 'fake-model' },
    credentials: { apiKey: 'k1' },
    log: null,
    ...opts,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
  getExecutor.mockReturnValue({ noAuth: false, refreshCredentials: vi.fn() });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('executor-delegating adapters', () => {
  it('returns JSON response from executeViaExecutor and calls onRequestSuccess', async () => {
    const responseBody = { created: 1, data: [{ b64_json: PNG_B64 }] };
    const adapter = baseAdapter({
      useExecutor: true,
      executeViaExecutor: vi.fn(async () => responseBody),
    });
    getImageAdapter.mockReturnValue(adapter);
    const onRequestSuccess = vi.fn();

    const result = await call({ onRequestSuccess });

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledOnce();
    expect(global.fetch).not.toHaveBeenCalled();
    const json = await result.response.json();
    expect(json).toEqual(responseBody);
  });

  it('keeps raw body when normalize output is not OpenAI-shaped', async () => {
    const raw = { something: 'else' };
    const adapter = baseAdapter({
      useExecutor: true,
      executeViaExecutor: vi.fn(async () => raw),
      normalize: vi.fn(() => ({ not: 'openai' })),
    });
    getImageAdapter.mockReturnValue(adapter);

    const result = await call();
    expect(await result.response.json()).toEqual(raw);
  });

  it('binaryOutput decodes b64_json to bytes with the requested mime', async () => {
    const adapter = baseAdapter({
      useExecutor: true,
      executeViaExecutor: vi.fn(async () => ({ created: 1, data: [{ b64_json: PNG_B64 }] })),
    });
    getImageAdapter.mockReturnValue(adapter);

    const result = await call({ binaryOutput: true, body: { prompt: 'x', output_format: 'jpeg' } });

    expect(result.success).toBe(true);
    expect(result.response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(result.response.headers.get('Content-Disposition')).toContain('image.jpg');
    const buf = Buffer.from(await result.response.arrayBuffer());
    expect(buf.toString('utf8')).toBe('fake-image-bytes');
  });

  it('binaryOutput fetches url when b64_json is absent', async () => {
    const adapter = baseAdapter({
      useExecutor: true,
      executeViaExecutor: vi.fn(async () => ({
        created: 1,
        data: [{ url: 'https://img.invalid/i.png' }],
      })),
    });
    getImageAdapter.mockReturnValue(adapter);
    global.fetch.mockResolvedValueOnce(new Response(Buffer.from('url-bytes')));

    const result = await call({ binaryOutput: true });

    expect(global.fetch).toHaveBeenCalledWith('https://img.invalid/i.png');
    expect(result.response.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await result.response.arrayBuffer()).toString('utf8')).toBe('url-bytes');
  });

  it('maps AbortError to 499', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const adapter = baseAdapter({
      useExecutor: true,
      executeViaExecutor: vi.fn(async () => {
        throw err;
      }),
    });
    getImageAdapter.mockReturnValue(adapter);

    const result = await call();
    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
  });

  it('maps other executor errors to 502 with formatted message', async () => {
    const adapter = baseAdapter({
      useExecutor: true,
      executeViaExecutor: vi.fn(async () => {
        throw new Error('upstream blew up');
      }),
    });
    getImageAdapter.mockReturnValue(adapter);
    const log = { debug: vi.fn() };

    const result = await call({ log });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain('upstream blew up');
  });
});

describe('direct fetch path', () => {
  it('returns 400 when adapter build throws', async () => {
    const adapter = baseAdapter({
      buildUrl: vi.fn(() => {
        throw new Error('bad size');
      }),
    });
    getImageAdapter.mockReturnValue(adapter);

    const result = await call();
    expect(result.status).toBe(400);
    expect(result.error).toContain('bad size');
  });

  it('returns 502 when fetch rejects', async () => {
    getImageAdapter.mockReturnValue(baseAdapter());
    global.fetch.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await call();
    expect(result.status).toBe(502);
    expect(result.error).toContain('ECONNRESET');
  });

  it('refreshes credentials on 401 and retries with the new headers', async () => {
    const adapter = baseAdapter();
    getImageAdapter.mockReturnValue(adapter);
    refreshWithRetry.mockResolvedValueOnce({ apiKey: 'k2' });
    global.fetch
      .mockResolvedValueOnce(new Response('denied', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ created: 1, data: [] }), { status: 200 })
      );
    const onCredentialsRefreshed = vi.fn();
    const credentials = { apiKey: 'k1' };

    const result = await call({ credentials, onCredentialsRefreshed });

    expect(result.success).toBe(true);
    expect(credentials.apiKey).toBe('k2');
    expect(onCredentialsRefreshed).toHaveBeenCalledWith({ apiKey: 'k2' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer k2' });
  });

  it('returns a terminal failure when building the refreshed attempt throws', async () => {
    let builds = 0;
    const adapter = baseAdapter({
      buildBody: vi.fn(() => {
        if (++builds > 1) throw new Error('retry build failed');
        return {};
      }),
    });
    getImageAdapter.mockReturnValue(adapter);
    refreshWithRetry.mockResolvedValueOnce({ accessToken: 't2' });
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'no' } }), { status: 401 })
    );

    const result = await call({ log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.failureMetadata.safeToReplay).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns the upstream error when refresh yields no credentials', async () => {
    getImageAdapter.mockReturnValue(baseAdapter());
    refreshWithRetry.mockResolvedValueOnce(null);
    global.fetch.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const result = await call();
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(refreshWithRetry).toHaveBeenCalledOnce();
  });

  it('skips refresh for noAuth adapters', async () => {
    getImageAdapter.mockReturnValue(baseAdapter({ noAuth: true }));
    global.fetch.mockResolvedValueOnce(new Response('denied', { status: 401 }));

    const result = await call();
    expect(result.status).toBe(401);
    expect(refreshWithRetry).not.toHaveBeenCalled();
  });

  it('passes through an sseResponse from adapter.parseResponse', async () => {
    const sse = new Response('event: done\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const adapter = baseAdapter({ parseResponse: vi.fn(async () => ({ sseResponse: sse })) });
    getImageAdapter.mockReturnValue(adapter);
    global.fetch.mockResolvedValueOnce(new Response('stream', { status: 200 }));

    const result = await call({ streamToClient: true });
    expect(result.success).toBe(true);
    expect(result.response).toBe(sse);
  });

  it('returns 502 when adapter.parseResponse throws', async () => {
    const adapter = baseAdapter({
      parseResponse: vi.fn(async () => {
        throw new Error('no image in stream');
      }),
    });
    getImageAdapter.mockReturnValue(adapter);
    global.fetch.mockResolvedValueOnce(new Response('stream', { status: 200 }));

    const result = await call();
    expect(result.status).toBe(502);
    expect(result.error).toContain('no image in stream');
  });

  it('serializes string request bodies as-is', async () => {
    const adapter = baseAdapter({ buildBody: vi.fn(() => 'raw-string-body') });
    getImageAdapter.mockReturnValue(adapter);
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ created: 1, data: [] }), { status: 200 })
    );

    await call();
    expect(global.fetch.mock.calls[0][1].body).toBe('raw-string-body');
  });

  it('binaryOutput on the direct path falls back to JSON when the url fetch fails', async () => {
    const parsed = { created: 1, data: [{ url: 'https://img.invalid/broken.png' }] };
    getImageAdapter.mockReturnValue(baseAdapter());
    global.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify(parsed), { status: 200 }))
      .mockRejectedValueOnce(new Error('dns fail'));

    const result = await call({ binaryOutput: true });
    expect(result.success).toBe(true);
    expect(result.response.headers.get('Content-Type')).toBe('application/json');
    expect(await result.response.json()).toEqual(parsed);
  });

  it('binaryOutput on the direct path decodes b64_json', async () => {
    const parsed = { created: 1, data: [{ b64_json: PNG_B64 }] };
    getImageAdapter.mockReturnValue(baseAdapter());
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify(parsed), { status: 200 }));

    const result = await call({ binaryOutput: true, body: { prompt: 'x', output_format: 'webp' } });
    expect(result.response.headers.get('Content-Type')).toBe('image/webp');
    expect(Buffer.from(await result.response.arrayBuffer()).toString('utf8')).toBe(
      'fake-image-bytes'
    );
  });
});
