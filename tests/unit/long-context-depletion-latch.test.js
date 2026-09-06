import { describe, it, expect } from "vitest";
import {
  LONG_CONTEXT_DEPLETION_MARKERS,
  LONG_CONTEXT_DEPLETION_COOLDOWN_MS,
  isLongContextDepletion,
  scrubLongContextDepletion,
} from "open-sse/config/errorConfig.js";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import {
  buildErrorBody,
  errorResponse,
  createErrorResult,
  unavailableResponse,
} from "open-sse/utils/error.js";

// Same ceiling chat.js uses to decide between a same-account replay and a
// rotation; a depletion lock must clear it or the depleted account is retried.
const SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS = 30 * 1000;

// Upstream spelling: capitalised, wrapped in the provider's envelope, and as
// chatCore relays it after formatProviderError.
const upstreamShapes = (marker) => {
  const cased = marker[0].toUpperCase() + marker.slice(1);
  return [
    cased,
    `${cased}. Please add credits.`,
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: cased } }),
    `[429]: ${cased}`,
  ];
};

const carriesMarker = (text) =>
  LONG_CONTEXT_DEPLETION_MARKERS.some((m) => text.toLowerCase().includes(m));

describe("long-context credit 429: classification", () => {
  it("exports the two latch phrases and a lock longer than the same-account retry window", () => {
    expect(LONG_CONTEXT_DEPLETION_MARKERS).toHaveLength(2);
    expect(LONG_CONTEXT_DEPLETION_COOLDOWN_MS).toBeGreaterThan(SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS);
  });

  it.each(LONG_CONTEXT_DEPLETION_MARKERS)("treats a 429 carrying %j as account depletion", (marker) => {
    for (const text of upstreamShapes(marker)) {
      expect(isLongContextDepletion(text)).toBe(true);
      expect(checkFallbackError(429, text)).toEqual({
        shouldFallback: true,
        cooldownMs: LONG_CONTEXT_DEPLETION_COOLDOWN_MS,
      });
    }
  });

  it("leaves an ordinary 429 on the backoff schedule", () => {
    const res = checkFallbackError(429, "Rate limit exceeded");
    expect(res.shouldFallback).toBe(true);
    expect(res.newBackoffLevel).toBe(1);
    expect(res.cooldownMs).toBeLessThan(LONG_CONTEXT_DEPLETION_COOLDOWN_MS);
  });

  it("only applies on 429; the phrase on another status is not reclassified", () => {
    const text = upstreamShapes(LONG_CONTEXT_DEPLETION_MARKERS[0])[0];
    expect(checkFallbackError(400, text)).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("fails open on non-string input", () => {
    for (const bad of [null, undefined, "", 42, { error: null }, ["x"]]) {
      expect(() => isLongContextDepletion(bad)).not.toThrow();
      expect(isLongContextDepletion(bad)).toBe(false);
      expect(scrubLongContextDepletion(bad)).toBe(bad);
    }
  });
});

describe("long-context credit 429: client-bound bodies never carry the latch phrase", () => {
  it.each(LONG_CONTEXT_DEPLETION_MARKERS)("errorResponse rewrites %j and keeps 429 + Retry-After", async (marker) => {
    for (const text of upstreamShapes(marker)) {
      const res = errorResponse(429, text, { retryAfter: { ms: 90_000 } });
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("90");
      const raw = await res.text();
      expect(carriesMarker(raw)).toBe(false);
      const body = JSON.parse(raw);
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  });

  it.each(LONG_CONTEXT_DEPLETION_MARKERS)("createErrorResult (chatCore path) rewrites %j", async (marker) => {
    const result = createErrorResult(429, `[429]: ${marker}`, null, null, "rid-1");
    expect(result.status).toBe(429);
    expect(carriesMarker(await result.response.text())).toBe(false);
  });

  it.each(LONG_CONTEXT_DEPLETION_MARKERS)("unavailableResponse (pool exhausted) rewrites %j", async (marker) => {
    const at = new Date(Date.now() + 60_000).toISOString();
    const res = unavailableResponse(429, `[anthropic/claude-x] ${marker}`, at, "reset after 1m");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const raw = await res.text();
    expect(carriesMarker(raw)).toBe(false);
    expect(JSON.parse(raw).error.message).toContain("(reset after 1m)");
  });

  it("scrub keeps surrounding context and is a no-op on clean messages", () => {
    const clean = "Rate limit exceeded, retry in 30 seconds";
    expect(scrubLongContextDepletion(clean)).toBe(clean);
    expect(buildErrorBody(429, clean).error.message).toBe(clean);
    const prefixed = `[anthropic/claude-x] ${upstreamShapes(LONG_CONTEXT_DEPLETION_MARKERS[1])[0]}`;
    expect(scrubLongContextDepletion(prefixed)).toMatch(/^\[anthropic\/claude-x\] /);
  });
});
