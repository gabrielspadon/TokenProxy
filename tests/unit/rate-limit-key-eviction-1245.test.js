import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The chat rate limiter only ever ADDED keys: one entry per api key or client
// IP, kept for the process lifetime. A gateway left running for days grew it
// without bound, which is the linear memory growth reported in #1245.
const { __rateLimiter } = await import("@/sse/handlers/chat.js");

const WINDOW_MS = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  __rateLimiter.reset();
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

  it("still limits a caller over the per-window ceiling", () => {
    // Agnostic of the configured ceiling: one more call than the window allows
    // must be refused, whatever RATE_LIMIT_MAX_REQUESTS resolves to.
    let limited = false;
    for (let i = 0; i < 10000 && !limited; i++) limited = __rateLimiter.isRateLimited("noisy");
    expect(limited).toBe(true);
  });
});
