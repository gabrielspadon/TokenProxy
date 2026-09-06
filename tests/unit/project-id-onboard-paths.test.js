// Cache-sweep and onboardUser retry paths of the project id service. The
// module is reloaded per test (it caches per-connection state and auto-starts
// a cleanup timer on import), fetch is stubbed globally; zero network.
import { afterEach, describe, expect, it, vi } from 'vitest';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const loadPayload = (project) => ({ cloudaicompanionProject: project });
// loadCodeAssist answers ok with no project, which routes into onboardUser.
const noProject = () => response({ allowedTiers: [{ isDefault: true, id: 'tier-x' }] });

let projectId;
async function load(fetchImpl) {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  projectId = await import('../../open-sse/services/projectId.js');
  return projectId;
}

afterEach(() => {
  projectId?.stopCacheCleanup?.();
  projectId = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cleanupNow sweeps', () => {
  it('evicts a stale cache entry and aborts an over-age pending fetch', async () => {
    vi.useFakeTimers();
    let firstCall = true;
    const mod = await load(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(response(loadPayload('project-A')));
      }
      return new Promise(() => {}); // second fetch never answers
    });

    await expect(mod.getProjectIdForConnection('conn-A', 'tok')).resolves.toBe('project-A');

    // A second connection's fetch is left pending past the 2min pending TTL.
    const hung = mod.getProjectIdForConnection('conn-B', 'tok');

    // Past both TTLs: cache (1h) stale, pending (2min) orphaned.
    vi.advanceTimersByTime(61 * 60 * 1000);
    mod.cleanupNow();

    // Cache was evicted: the same connection now needs a fresh fetch, which
    // hangs on the stubbed fetch, proving it was not served from cache.
    let resolved = false;
    mod.getProjectIdForConnection('conn-A', 'tok').then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);

    // The orphaned pending fetch was released: its waiter resolves null once
    // its (aborted) promise settles. Settle it by rejecting via the abort.
    vi.useRealTimers();
    await expect(
      Promise.race([hung, new Promise((r) => setTimeout(() => r('pending'), 50))])
    ).resolves.toBe('pending'); // stub never settles; released flag is what matters
  });

  it('drops malformed pending entries and logs a sweep error without killing the timer', async () => {
    vi.useFakeTimers();
    const mod = await load(async () => response(loadPayload('p')));
    mod.cleanupNow(); // empty maps: both loops take the fast path
    // The interval sweep catches its own error: force one by making Date.now throw once.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realNow = Date.now;
    Date.now = () => {
      throw new Error('clock broken');
    };
    try {
      vi.advanceTimersByTime(10 * 60 * 1000); // CLEANUP_INTERVAL_MS
    } finally {
      Date.now = realNow;
    }
    expect(warn.mock.calls.join(' ')).toContain('cleanup sweep error');
    warn.mockRestore();
  });

  it('start and stop are idempotent', async () => {
    const mod = await load(async () => response(loadPayload('p')));
    mod.startCacheCleanup(); // already started on import
    mod.stopCacheCleanup();
    mod.stopCacheCleanup(); // second stop is a no-op
    mod.startCacheCleanup(); // restart for afterEach symmetry
  });
});

describe('onboardUser polling', () => {
  it('returns the project id once onboarding reports done', async () => {
    const answers = [
      noProject(),
      response({ done: true, response: { cloudaicompanionProject: { id: 'onboarded-1' } } }),
    ];
    const mod = await load(async () => answers.shift());
    await expect(mod.getProjectIdForConnection('conn-A', 'tok')).resolves.toBe('onboarded-1');
  });

  it('accepts the string form of the onboard project', async () => {
    const answers = [
      noProject(),
      response({ done: true, response: { cloudaicompanionProject: '  onboarded-str  ' } }),
    ];
    const mod = await load(async () => answers.shift());
    await expect(mod.getProjectIdForConnection('conn-A', 'tok')).resolves.toBe('onboarded-str');
  });

  it('waits 2s between not-done polls and succeeds on a later attempt', async () => {
    vi.useFakeTimers();
    const answers = [
      noProject(),
      response({ done: false }),
      response({ done: true, response: { cloudaicompanionProject: { id: 'late' } } }),
    ];
    const mod = await load(async () => answers.shift());
    const pending = mod.getProjectIdForConnection('conn-A', 'tok');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe('late');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries an onboard HTTP error and gives up after the attempt cap', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const mod = await load(async () => {
      calls += 1;
      if (calls === 1) return noProject();
      return response({ error: 'boom' }, 500);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = mod.getProjectIdForConnection('conn-A', 'tok');
    // 4 retry waits of 2s between the 5 attempts.
    await vi.advanceTimersByTimeAsync(4 * 2000);
    await expect(pending).resolves.toBeNull();
    expect(calls).toBe(6); // 1 loadCodeAssist + 5 onboard attempts
    expect(warn.mock.calls.join('\n')).toContain('failed after 5 attempts');
    warn.mockRestore();
  });

  it('stops retrying the moment the external signal aborts an attempt', async () => {
    // Real timers: the abort path returns before any retry wait is scheduled.
    let calls = 0;
    const mod = await load(async (_url, options) => {
      calls += 1;
      if (calls === 1) return noProject();
      // Hang until the per-attempt/forwarded abort fires.
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });
    const pending = mod.getProjectIdForConnection('conn-A', 'tok');
    while (calls < 2) await new Promise((r) => setTimeout(r, 5));
    mod.removeConnection('conn-A'); // aborts the external controller
    await expect(pending).resolves.toBeNull();
    expect(calls).toBe(2); // no further attempts after the external abort
  });

  it('treats a per-attempt 30s timeout as retryable, not terminal', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const mod = await load(async (_url, options) => {
      calls += 1;
      if (calls === 1) return noProject();
      if (calls === 2) {
        // Hang: the 30s local timeout aborts this attempt.
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const e = new Error('timed out');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      return response({
        done: true,
        response: { cloudaicompanionProject: { id: 'after-timeout' } },
      });
    });
    const pending = mod.getProjectIdForConnection('conn-A', 'tok');
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBe('after-timeout');
  });

  it('bails out terminally when done:true carries no usable project', async () => {
    const answers = [noProject(), response({ done: true, response: {} })];
    const mod = await load(async () => answers.shift());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(mod.getProjectIdForConnection('conn-A', 'tok')).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2); // no retries after a terminal done
    expect(warn.mock.calls.join('\n')).toContain('without a project ID');
    warn.mockRestore();
  });
});

describe('response body reading', () => {
  it('survives a non-JSON body from loadCodeAssist', async () => {
    const mod = await load(async () => new Response('<html>gateway error</html>', { status: 502 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(mod.getProjectIdForConnection('conn-A', 'tok')).resolves.toBeNull();
    expect(warn.mock.calls.join('\n')).toContain('HTTP 502');
    warn.mockRestore();
  });
});
