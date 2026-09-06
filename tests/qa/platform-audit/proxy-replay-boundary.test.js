import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const previousFetch = globalThis.fetch;
const native = vi.fn();
globalThis.fetch = native;
const { proxyAwareFetch } = await import('../../../open-sse/utils/proxyFetch.js');
const proxy = { enabled: true, url: 'http://127.0.0.1:1', strictProxy: false };
beforeEach(() => native.mockReset());
afterAll(() => { globalThis.fetch = previousFetch; });

describe('independent proxy transport replay boundary', () => {
  it.each(['https://provider.invalid/generate', 'https://audit.proxy.individual.githubcopilot.com/chat/completions'])('never falls through to direct transport after an uncertain POST at %s', async (url) => {
    const error = new Error('proxy socket closed after write');
    native.mockRejectedValueOnce(error).mockResolvedValue(Response.json({ answer: 'duplicate' }));
    await expect(proxyAwareFetch(url, { method: 'POST', body: '{}' }, proxy)).rejects.toBe(error);
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('keeps existing read-only GET fallback semantics', async () => {
    native.mockRejectedValueOnce(new Error('proxy down')).mockResolvedValue(Response.json({ status: 'ready' }));
    const response = await proxyAwareFetch('https://provider.invalid/models', { method: 'GET' }, proxy);
    expect(response.status).toBe(200);
    expect(native).toHaveBeenCalledTimes(2);
  });
});
