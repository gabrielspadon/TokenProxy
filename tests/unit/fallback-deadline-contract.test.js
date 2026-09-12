import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFallbackDeadline, getRequestFallbackDeadline } from '../../open-sse/utils/fallbackDeadline.js';
import { handleComboChat } from '../../open-sse/services/combo.js';
import { createExecutorResponseHeaderTimeout } from '../../open-sse/utils/responseHeaderTimeout.js';

const log = { info() {}, warn() {}, error() {} };
const body = { messages: [{ role: 'user', content: 'hello' }] };
const failure = () => Response.json({ error: { message: 'quota' } }, {
  status: 429, headers: { 'x-tokenproxy-replay-safe': 'true' },
});

describe('shared fallback deadline', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('reuses the request budget despite wall-clock jumps', async () => {
    const request = {};
    const deadline = getRequestFallbackDeadline(request);
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(Date.now() - 3600_000);
    expect(getRequestFallbackDeadline(request)).toBe(deadline);
    expect(deadline.remainingMs()).toBe(119_000);
  });

  it('reclaims a result from an operation that ignored cancellation', async () => {
    const abort = new AbortController();
    const reclaim = vi.fn();
    let finish;
    const pending = createFallbackDeadline().run(() => new Promise(resolve => { finish = resolve; }), {
      signal: abort.signal, onLateResult: reclaim,
    }).catch(error => error);
    await Promise.resolve();
    abort.abort(new Error('caller gone'));
    expect((await pending).message).toBe('caller gone');
    finish('reserved lease');
    await vi.advanceTimersByTimeAsync(0);
    expect(reclaim).toHaveBeenCalledWith('reserved lease');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not dispatch the next nested member after the shared budget', async () => {
    const deadline = createFallbackDeadline();
    const calls = [];
    const nested = () => handleComboChat({ body, models: ['p/a', 'p/b'], log, deadline,
      handleSingleModel: async (_, model) => {
        calls.push(model);
        await vi.advanceTimersByTimeAsync(120_001);
        return failure();
      },
    });
    const response = await handleComboChat({ body, models: ['nested', 'p/outer'], log, deadline,
      handleSingleModel: async (_, model) => { calls.push(model); return model === 'nested' ? nested() : failure(); },
    });
    expect(calls).toEqual(['nested', 'p/a']);
    expect(response.status).toBe(504);
  });

  it('cancels a retry wait immediately with no extra attempt or timer', async () => {
    const caller = new AbortController();
    const dispatch = vi.fn(async () => Response.json({ error: { message: 'Service unavailable' } }, {
      status: 503, headers: { 'x-tokenproxy-replay-safe': 'true', 'retry-after': '8' },
    }));
    const pending = handleComboChat({ body, models: ['p/a', 'p/b'], log, signal: caller.signal, handleSingleModel: dispatch });
    await vi.advanceTimersByTimeAsync(1);
    caller.abort();
    await vi.advanceTimersByTimeAsync(1);
    // Also advance the old uncancellable timer so a regression fails rather than hangs.
    await vi.advanceTimersByTimeAsync(60_000);
    const response = await pending;
    expect(response.status).toBe(499);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits header acquisition to the remaining subsecond budget', async () => {
    const fallbackDeadline = createFallbackDeadline({ timeoutMs: 1200 });
    await vi.advanceTimersByTimeAsync(900);
    const headers = createExecutorResponseHeaderTimeout({
      connectTimeout: { globalTimeout: 15_000, fallbackDeadline },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(headers.signal.aborted).toBe(true);
    expect(headers.signal.reason.code).toBe('FALLBACK_DEADLINE_EXCEEDED');
    headers.clear();
  });

  it('does not cut a healthy stream after its headers completed', async () => {
    const fallbackDeadline = createFallbackDeadline({ timeoutMs: 1200 });
    const headers = createExecutorResponseHeaderTimeout({ connectTimeout: { globalTimeout: 15_000, fallbackDeadline } });
    await vi.advanceTimersByTimeAsync(1100);
    headers.clear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(headers.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the fallback budget at headers while preserving caller cancellation', async () => {
    const deadline = createFallbackDeadline({ timeoutMs: 1000 });
    const caller = new AbortController();
    let heldSignal;
    const result = deadline.run(async (signal, headersReceived) => {
      heldSignal = signal;
      headersReceived();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal.aborted).toBe(false);
      return 'healthy buffered output';
    }, { signal: caller.signal });
    expect(await result).toBe('healthy buffered output');
    caller.abort();
    expect(heldSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
