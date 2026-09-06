import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The chat rate limiter only ever ADDED keys: one entry per api key or client
// IP, kept for the process lifetime. A gateway left running for days grew it
// without bound, which is the linear memory growth reported in #1245.
const { __rateLimiter, __admissionQueue } = await import("@/sse/handlers/chat.js");

const WINDOW_MS = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  __rateLimiter.reset();
  __admissionQueue.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chat rate limiter key eviction (#1245)", () => {
  it("drops keys whose window has gone quiet", () => {
    for (let i = 0; i < 500; i++) __rateLimiter.isRateLimited(`ip-${i}`);
    expect(__rateLimiter.size()).toBe(500);

    vi.advanceTimersByTime(WINDOW_MS + 1);
    __rateLimiter.isRateLimited("still-here");

    expect(__rateLimiter.size()).toBe(1);
  });

  it("keeps a key that is still inside its window", () => {
    __rateLimiter.isRateLimited("busy");
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(WINDOW_MS - 1);
      __rateLimiter.isRateLimited("busy");
    }
    expect(__rateLimiter.size()).toBe(1);
  });

  it("still limits an UNAUTHENTICATED caller over the per-window ceiling", () => {
    // Agnostic of the configured ceiling: one more call than the window allows
    // must be refused, whatever RATE_LIMIT_MAX_REQUESTS resolves to. This is
    // the abuse boundary and the queue below deliberately does not soften it.
    let limited = false;
    for (let i = 0; i < 10000 && !limited; i++) limited = __rateLimiter.isRateLimited("noisy");
    expect(limited).toBe(true);
  });
});

// The authenticated half of admission. A valid api key is not counted against a
// request window at all: ~30 parallel agents share one key, so the ceiling that
// matters is CONCURRENCY, and a request over it waits instead of being refused.
describe("chat admission queue (authenticated keys)", () => {
  const KEY = "api-key-under-test";

  const fill = async (key, n) => {
    for (let i = 0; i < n; i++) {
      const slot = await __admissionQueue.acquire(key);
      expect(slot.admitted).toBe(true);
    }
  };

  it("queues past the concurrency ceiling instead of refusing", async () => {
    const { inflight } = __admissionQueue.limits();
    await fill(KEY, inflight);

    let settled = null;
    const waiting = __admissionQueue.acquire(KEY).then((slot) => {
      settled = slot;
    });
    await Promise.resolve();

    // The request past the ceiling is WAITING, which is the whole point: the
    // old shape answered 429 here and killed the agent that sent it.
    expect(settled).toBeNull();
    expect(__admissionQueue.stateOf(KEY)).toEqual({ active: inflight, queued: 1 });

    __admissionQueue.release(KEY);
    await waiting;
    expect(settled.admitted).toBe(true);
    expect(settled.waitedMs).toBeGreaterThanOrEqual(0);
    expect(__admissionQueue.stateOf(KEY)).toEqual({ active: inflight, queued: 0 });
  });

  it("hands a freed slot to the head of the queue, in FIFO order", async () => {
    const { inflight } = __admissionQueue.limits();
    await fill(KEY, inflight);

    const order = [];
    const first = __admissionQueue.acquire(KEY).then(() => order.push("first"));
    const second = __admissionQueue.acquire(KEY).then(() => order.push("second"));
    await Promise.resolve();

    __admissionQueue.release(KEY);
    await first;
    expect(order).toEqual(["first"]);

    __admissionQueue.release(KEY);
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("refuses ONLY past queue capacity, with a hint inside the wait budget", async () => {
    const { inflight, depth, waitMs } = __admissionQueue.limits();
    await fill(KEY, inflight);
    const queued = [];
    for (let i = 0; i < depth; i++) queued.push(__admissionQueue.acquire(KEY));
    await Promise.resolve();

    const refused = await __admissionQueue.acquire(KEY);
    expect(refused.admitted).toBe(false);
    expect(refused.why).toBe("queue-full");
    expect(refused.queued).toBe(depth);
    // Truthful, not a constant: the head waiter's own deadline is the earliest
    // instant a queue slot can free without predicting an upstream.
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(waitMs);
  });

  it("evicts a waiter that outlives the wait budget", async () => {
    const { inflight, waitMs } = __admissionQueue.limits();
    await fill(KEY, inflight);

    const late = __admissionQueue.acquire(KEY);
    await vi.advanceTimersByTimeAsync(waitMs + 1);

    const slot = await late;
    expect(slot.admitted).toBe(false);
    expect(slot.why).toBe("wait-timeout");
    expect(slot.waitedMs).toBeGreaterThanOrEqual(waitMs);
    expect(__admissionQueue.stateOf(KEY)).toEqual({ active: inflight, queued: 0 });
  });

  it("drops idle keys, under the same #1245 memory bound as the window", async () => {
    for (let i = 0; i < 500; i++) {
      await __admissionQueue.acquire(`api-${i}`);
      __admissionQueue.release(`api-${i}`);
    }
    expect(__admissionQueue.size()).toBe(500);

    vi.advanceTimersByTime(WINDOW_MS + 1);
    await __admissionQueue.acquire("still-here");

    expect(__admissionQueue.size()).toBe(1);
  });

  it("keeps a key that still has a request in flight", async () => {
    await __admissionQueue.acquire("busy");
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await __admissionQueue.acquire("other");

    expect(__admissionQueue.stateOf("busy")).toEqual({ active: 1, queued: 0 });
  });
});
