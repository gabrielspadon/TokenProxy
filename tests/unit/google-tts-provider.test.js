// Google Translate TTS provider: token scrape + batchexecute RPC, chunked long
// input. All fetch traffic mocked; module token cache reset via resetModules.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const TOKEN_HTML = 'stuff "FdrFJe":"sid-123" more "cfb2h":"bl-456" tail';

// >=100 chars of valid base64 (the provider rejects shorter audio as empty).
const B64_A = Buffer.from('a'.repeat(90)).toString('base64');
const B64_B = Buffer.from('b'.repeat(90)).toString('base64');

function tokenRes(html = TOKEN_HTML, status = 200) {
  return new Response(html, { status });
}

function rpcRes(base64, status = 200) {
  const line3 = JSON.stringify([['wrb.fr', 'jQ1olc', JSON.stringify([base64])]]);
  return new Response([")]}'", '', '12', line3].join('\n'), { status });
}

async function loadProvider() {
  vi.resetModules();
  const mod = await import('../../open-sse/handlers/ttsProviders/googleTts.js');
  return mod.default;
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('googleTts synthesize', () => {
  it('scrapes the token, posts the RPC, and returns base64 mp3', async () => {
    globalThis.fetch.mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(rpcRes(B64_A));
    const provider = await loadProvider();
    const out = await provider.synthesize('hello world', 'fr');

    expect(out).toEqual({ base64: B64_A, format: 'mp3' });
    expect(provider.noAuth).toBe(true);

    const [rpcUrl, rpcOpts] = globalThis.fetch.mock.calls[1];
    const url = new URL(rpcUrl);
    expect(url.searchParams.get('f.sid')).toBe('sid-123');
    expect(url.searchParams.get('bl')).toBe('bl-456');
    expect(url.searchParams.get('hl')).toBe('fr');
    expect(rpcOpts.method).toBe('POST');
    expect(rpcOpts.body).toContain('f.req=');
  });

  it('defaults the language to en and reuses the cached token', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(rpcRes(B64_A))
      .mockResolvedValueOnce(rpcRes(B64_B));
    const provider = await loadProvider();
    await provider.synthesize('one', null);
    await provider.synthesize('two', null);

    // 1 token scrape + 2 RPCs, no second scrape.
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(new URL(globalThis.fetch.mock.calls[1][0]).searchParams.get('hl')).toBe('en');
  });

  it('strips special characters before synthesis', async () => {
    globalThis.fetch.mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(rpcRes(B64_A));
    const provider = await loadProvider();
    await provider.synthesize('a@b (c) "d", e', 'en');
    const body = decodeURIComponent(globalThis.fetch.mock.calls[1][1].body);
    expect(body).not.toContain('@');
    expect(body).not.toContain('(');
  });

  it('chunks long input and concatenates the audio', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(rpcRes(B64_A))
      .mockResolvedValueOnce(rpcRes(B64_B));
    const provider = await loadProvider();
    const long = 'The quick brown fox jumps over the lazy dog. '.repeat(8); // > 200 chars
    const out = await provider.synthesize(long, 'en');

    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // token + 2 pieces
    const expected = Buffer.concat([
      Buffer.from(B64_A, 'base64'),
      Buffer.from(B64_B, 'base64'),
    ]).toString('base64');
    expect(out).toEqual({ base64: expected, format: 'mp3' });
  });

  it('throws when the token page fetch fails', async () => {
    globalThis.fetch.mockResolvedValueOnce(tokenRes('', 503));
    const provider = await loadProvider();
    await expect(provider.synthesize('hi', 'en')).rejects.toThrow(/503/);
  });

  it('throws when the token cannot be parsed from the page', async () => {
    globalThis.fetch.mockResolvedValueOnce(tokenRes('<html>nothing here</html>'));
    const provider = await loadProvider();
    await expect(provider.synthesize('hi', 'en')).rejects.toThrow(/parse/i);
  });

  it('throws when the RPC fails', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const provider = await loadProvider();
    await expect(provider.synthesize('hi', 'en')).rejects.toThrow(/500/);
  });

  it('rejects audio shorter than 100 chars as empty', async () => {
    globalThis.fetch.mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(rpcRes('QUJD'));
    const provider = await loadProvider();
    await expect(provider.synthesize('hi', 'en')).rejects.toThrow(/empty audio/);
  });
});
