import { afterEach, describe, expect, it, vi } from 'vitest';
import adapter from 'open-sse/handlers/imageProviders/blackForestLabs.js';
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  nowSec,
} from 'open-sse/handlers/imageProviders/_base.js';
import { PROVIDER_MEDIA } from 'open-sse/providers/index.js';

const BASE_URL = PROVIDER_MEDIA['black-forest-labs']?.imageConfig?.baseUrl;

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('blackForestLabs adapter', () => {
  it('is async and builds the submit URL from the registry imageConfig', () => {
    expect(adapter.async).toBe(true);
    expect(BASE_URL).toBeTruthy();
    expect(adapter.buildUrl('some-model')).toBe(`${BASE_URL}/some-model`);
  });

  it('buildHeaders prefers apiKey, falls back to accessToken, tolerates no creds', () => {
    expect(adapter.buildHeaders({ apiKey: 'k1', accessToken: 't1' })['x-key']).toBe('k1');
    expect(adapter.buildHeaders({ accessToken: 't1' })['x-key']).toBe('t1');
    const none = adapter.buildHeaders(undefined);
    expect(none['Content-Type']).toBe('application/json');
    expect(none['x-key']).toBeUndefined();
  });

  it('buildBody maps prompt, size and image', () => {
    expect(adapter.buildBody('m', { prompt: 'p' })).toEqual({ prompt: 'p' });
    expect(adapter.buildBody('m', { prompt: 'p', size: '1024x768' })).toEqual({
      prompt: 'p',
      width: 1024,
      height: 768,
    });
    // Unparseable size dimensions are dropped, not NaN-forwarded
    const bad = adapter.buildBody('m', { prompt: 'p', size: 'wide' });
    expect(bad.width).toBeUndefined();
    expect(bad.height).toBeUndefined();
    expect(adapter.buildBody('m', { prompt: 'p', image: 'b64' }).image_prompt).toBe('b64');
  });

  it('parseResponse throws when no polling_url is returned', async () => {
    await expect(
      adapter.parseResponse(jsonResponse({}), { headers: { 'x-key': 'k' } })
    ).rejects.toThrow(/polling_url/);
  });

  it('polls until Ready and forwards the poll auth header', async () => {
    vi.useFakeTimers();
    const states = [{ status: 'Pending' }, { status: 'Ready', result: { sample: 'https://img' } }];
    const fetchMock = vi.fn(async () => jsonResponse(states.shift()));
    vi.stubGlobal('fetch', fetchMock);

    const p = adapter.parseResponse(jsonResponse({ polling_url: 'https://poll' }), {
      headers: { 'x-key': 'sek' },
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2 + 10);
    const out = await p;
    expect(out.status).toBe('Ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers['x-key']).toBe('sek');
  });

  it('throws on a non-ok poll response', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(null, false, 500))
    );
    const p = adapter.parseResponse(jsonResponse({ polling_url: 'https://poll' }), {
      headers: { 'x-key': 'k' },
    });
    const assertion = expect(p).rejects.toThrow(/500/);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10);
    await assertion;
  });

  it('throws the upstream error message on Error/Failed status', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'Error', error: 'boom' }))
    );
    const p = adapter.parseResponse(jsonResponse({ polling_url: 'https://poll' }), {
      headers: { 'x-key': 'k' },
    });
    const assertion = expect(p).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10);
    await assertion;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'Failed' }))
    );
    const p2 = adapter.parseResponse(jsonResponse({ polling_url: 'https://poll' }), {
      headers: { 'x-key': 'k' },
    });
    const assertion2 = expect(p2).rejects.toThrow(/generation failed/);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10);
    await assertion2;
  });

  it('times out when the deadline passes without a terminal status', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'Pending' }))
    );
    const p = adapter.parseResponse(jsonResponse({ polling_url: 'https://poll' }), {
      headers: { 'x-key': 'k' },
    });
    const assertion = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS);
    await assertion;
  });

  it('normalize returns the sample URL, or empty data without one', () => {
    const before = nowSec();
    const withSample = adapter.normalize({ result: { sample: 'https://img' } });
    expect(withSample.data).toEqual([{ url: 'https://img' }]);
    expect(withSample.created).toBeGreaterThanOrEqual(before);
    expect(adapter.normalize({}).data).toEqual([]);
  });
});
