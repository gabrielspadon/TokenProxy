import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: fetchMock }));

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const quotaPayload = { five_hour: { utilization: 40, resets_at: '2026-09-01T00:00:00.000Z' } };

// Module-level caches persist for the module's lifetime, so every case gets its own.
async function freshModule() {
  vi.resetModules();
  return import('../../open-sse/services/usage/claude.js');
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
});

afterEach(() => vi.useRealTimers());

describe('Claude usage cache lifetime (#2848)', () => {
  it('cancels a bounded quota read without poisoning a concurrent dashboard read', async () => {
    const { getClaudeUsage } = await freshModule();
    const dashboardFetch = Promise.withResolvers();
    const ownerStarted = Promise.withResolvers();
    fetchMock.mockImplementation((_url, _init, proxy) => {
      if (!proxy?.signal) return dashboardFetch.promise;
      ownerStarted.resolve();
      return new Promise((_resolve, reject) => proxy.signal.addEventListener('abort', () => reject(proxy.signal.reason), { once: true }));
    });
    const dashboard = getClaudeUsage('tok-shared');
    const owner = new AbortController();
    const quota = getClaudeUsage('tok-shared', null, { signal: owner.signal }).catch(error => error);
    await ownerStarted.promise;
    const reason = new DOMException('quota timeout', 'TimeoutError');
    owner.abort(reason);
    expect(await quota).toBe(reason);
    dashboardFetch.resolve(json(quotaPayload));
    expect((await dashboard).quotas['session (5h)'].remaining).toBe(60);
    expect((await getClaudeUsage('tok-shared')).quotas['session (5h)'].remaining).toBe(60);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports the expiry on 401 instead of serving the last good quota', async () => {
    const { getClaudeUsage } = await freshModule();
    fetchMock.mockResolvedValueOnce(json(quotaPayload));

    const first = await getClaudeUsage('tok-a');
    expect(first.quotas['session (5h)'].remaining).toBe(60);

    vi.advanceTimersByTime(6 * 60 * 1000);
    fetchMock.mockResolvedValue(json({ error: 'unauthorized' }, 401));

    const second = await getClaudeUsage('tok-a');
    expect(second.quotas).toBeUndefined();
    expect(second.expired).toBe(true);
  });

  it("drops the dead token's entries so the next read is a real fetch", async () => {
    const { getClaudeUsage } = await freshModule();
    fetchMock.mockResolvedValueOnce(json(quotaPayload));
    await getClaudeUsage('tok-a');

    vi.advanceTimersByTime(6 * 60 * 1000);
    fetchMock.mockResolvedValue(json({ error: 'unauthorized' }, 401));
    await getClaudeUsage('tok-a');

    const callsAfterExpiry = fetchMock.mock.calls.length;
    await getClaudeUsage('tok-a');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterExpiry);
  });

  it('does not serve one transient failure forever', async () => {
    const { getClaudeUsage } = await freshModule();
    // 429 on the quota endpoint, then a legacy leg that cannot answer either:
    // a soft failure, so nothing cacheable comes back.
    fetchMock.mockResolvedValue(json({ error: 'rate limited' }, 429));

    await getClaudeUsage('tok-b');
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await getClaudeUsage('tok-b');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('bounds the cache so a rotating token cannot grow it without limit', async () => {
    const { getClaudeUsage } = await freshModule();
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(() => json(quotaPayload));

    const tokens = Array.from({ length: 200 }, (_, i) => `tok-${i}`);
    for (const token of tokens) await getClaudeUsage(token);

    const callsAfterFill = fetchMock.mock.calls.length;
    expect(callsAfterFill).toBe(tokens.length);

    // The newest token is still cached; the oldest was evicted long ago.
    await getClaudeUsage(tokens.at(-1));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFill);

    await getClaudeUsage(tokens[0]);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFill + 1);
  });
});
