// Edge/Bing TTS provider: token scrape + caching, SSML request shape, 429/403
// retry, voices cache. All fetch traffic mocked; module state reset per test
// via resetModules since the caches are module-scoped.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TOKEN_HTML = 'var params_AbusePreventionHelper = [12345,"tok-abc",3600000];';

function translatorRes({
  html = TOKEN_HTML,
  cookies = ['MUID=x; path=/', 'SNRHOP=y; secure'],
} = {}) {
  const res = new Response(html, { status: 200 });
  res.headers.getSetCookie = () => cookies;
  return res;
}

function audioRes(bytes = 2048, status = 200) {
  return new Response(new Uint8Array(bytes).fill(1), { status });
}

async function loadProvider() {
  vi.resetModules();
  const mod = await import('open-sse/handlers/ttsProviders/edgeTts.js');
  return { provider: mod.default, fetchEdgeTtsVoices: mod.fetchEdgeTtsVoices };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('synthesize', () => {
  it('scrapes the token, posts SSML with cookie, and returns base64 mp3', async () => {
    globalThis.fetch.mockResolvedValueOnce(translatorRes()).mockResolvedValueOnce(audioRes());
    const { provider } = await loadProvider();
    const out = await provider.synthesize('xin chào', 'vi-VN-HoaiMyNeural');

    expect(out.format).toBe('mp3');
    expect(Buffer.from(out.base64, 'base64').byteLength).toBe(2048);

    const [ttsUrl, ttsOpts] = globalThis.fetch.mock.calls[1];
    expect(String(ttsUrl)).toContain('bing.com');
    expect(ttsOpts.method).toBe('POST');
    const body = new URLSearchParams(ttsOpts.body);
    expect(body.get('key')).toBe('12345');
    expect(body.get('token')).toBe('tok-abc');
    expect(body.get('ssml')).toContain('vi-VN-HoaiMyNeural');
    expect(body.get('ssml')).toContain("xml:lang='vi-VN'");
    expect(body.get('ssml')).toContain('xin chào');
    expect(ttsOpts.headers.Cookie).toBe('MUID=x; SNRHOP=y');
  });

  it('defaults the voice and reuses the cached token on a second call', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(translatorRes())
      .mockResolvedValueOnce(audioRes())
      .mockResolvedValueOnce(audioRes());
    const { provider } = await loadProvider();
    await provider.synthesize('a', null);
    await provider.synthesize('b', null);
    // 1 token scrape + 2 TTS posts — no second scrape.
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    const ssml = new URLSearchParams(globalThis.fetch.mock.calls[1][1].body).get('ssml');
    expect(ssml).toContain('vi-VN-HoaiMyNeural');
  });

  it('marks a male voice as Male in the SSML', async () => {
    globalThis.fetch.mockResolvedValueOnce(translatorRes()).mockResolvedValueOnce(audioRes());
    const { provider } = await loadProvider();
    await provider.synthesize('hi', 'en-US-GuyMaleNeural');
    const ssml = new URLSearchParams(globalThis.fetch.mock.calls[1][1].body).get('ssml');
    expect(ssml).toContain("xml:gender='Male'");
  });

  it('re-scrapes the token and retries once on 429', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(translatorRes())
      .mockResolvedValueOnce(audioRes(0, 429))
      .mockResolvedValueOnce(translatorRes())
      .mockResolvedValueOnce(audioRes());
    const { provider } = await loadProvider();
    const out = await provider.synthesize('hi', 'en-US-JennyNeural');
    expect(out.format).toBe('mp3');
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it('throws with status and body when the retry also fails', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(translatorRes())
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(translatorRes())
      .mockResolvedValueOnce(new Response('still denied', { status: 403 }));
    const { provider } = await loadProvider();
    await expect(provider.synthesize('hi', 'en-US-JennyNeural')).rejects.toThrow(
      /403.*still denied/
    );
  });

  it('throws on a non-retryable TTS failure', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(translatorRes())
      .mockResolvedValueOnce(new Response('oops', { status: 500 }));
    const { provider } = await loadProvider();
    await expect(provider.synthesize('hi', 'x-y-z')).rejects.toThrow(/500/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects audio smaller than 1KiB as empty', async () => {
    globalThis.fetch.mockResolvedValueOnce(translatorRes()).mockResolvedValueOnce(audioRes(10));
    const { provider } = await loadProvider();
    await expect(provider.synthesize('hi', 'x-y-z')).rejects.toThrow(/empty audio/);
  });

  it('throws when the translator page fetch fails', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    const { provider } = await loadProvider();
    await expect(provider.synthesize('hi', 'x-y-z')).rejects.toThrow(/503/);
  });

  it('throws when the abuse-prevention token cannot be parsed', async () => {
    globalThis.fetch.mockResolvedValueOnce(translatorRes({ html: '<html>no token here</html>' }));
    const { provider } = await loadProvider();
    await expect(provider.synthesize('hi', 'x-y-z')).rejects.toThrow(/parse/i);
  });

  it('omits the Cookie header when no cookies were set', async () => {
    const res = new Response(TOKEN_HTML, { status: 200 });
    res.headers.getSetCookie = () => [];
    globalThis.fetch.mockResolvedValueOnce(res).mockResolvedValueOnce(audioRes());
    const { provider } = await loadProvider();
    await provider.synthesize('hi', 'x-y-z');
    expect(globalThis.fetch.mock.calls[1][1].headers.Cookie).toBeUndefined();
  });

  it('exposes noAuth', async () => {
    const { provider } = await loadProvider();
    expect(provider.noAuth).toBe(true);
  });
});

describe('fetchEdgeTtsVoices', () => {
  it('fetches the voice list once and serves the cache afterwards', async () => {
    const voices = [{ ShortName: 'vi-VN-HoaiMyNeural' }];
    globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(voices), { status: 200 }));
    const { fetchEdgeTtsVoices } = await loadProvider();
    expect(await fetchEdgeTtsVoices()).toEqual(voices);
    expect(await fetchEdgeTtsVoices()).toEqual(voices);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws when the voices endpoint fails', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    const { fetchEdgeTtsVoices } = await loadProvider();
    await expect(fetchEdgeTtsVoices()).rejects.toThrow(/500/);
  });
});
