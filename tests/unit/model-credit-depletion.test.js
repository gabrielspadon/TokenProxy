import { describe, it, expect } from "vitest";
import {
  MODEL_CREDIT_DEPLETION_MARKERS,
  LONG_CONTEXT_DEPLETION_MARKERS,
  LONG_CONTEXT_DEPLETION_COOLDOWN_MS,
  isModelCreditDepletion,
  scrubLongContextDepletion,
} from "open-sse/config/errorConfig.js";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import { classifyAccountFailure } from "@/shared/utils/accountFailureClass.js";

// Same ceiling chat.js uses to decide between a same-account replay and a
// rotation; a depletion lock must clear it or mustWait blocks the pool.
const SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS = 30 * 1000;

// Upstream spelling, as observed on 2026-09-08 refusing claude-fable-5-1 on an
// account that served claude-opus-5 and claude-sonnet-5 from the same credential.
const upstreamShapes = (marker) => {
  const cased = marker[0].toUpperCase() + marker.slice(1);
  return [
    `${cased}.`,
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: cased } }),
    `[429]: ${cased}.`,
    `[429]: [429]: ${cased}.`,
  ];
};

describe("model credit 429: classification", () => {
  it.each(MODEL_CREDIT_DEPLETION_MARKERS)(
    "treats a 429 carrying %j as (account, model) depletion",
    (marker) => {
      for (const text of upstreamShapes(marker)) {
        expect(isModelCreditDepletion(text)).toBe(true);
        expect(checkFallbackError(429, text)).toEqual({
          shouldFallback: true,
          cooldownMs: LONG_CONTEXT_DEPLETION_COOLDOWN_MS,
        });
      }
    },
  );

  it("locks longer than the same-account retry window so the loop rotates", () => {
    expect(LONG_CONTEXT_DEPLETION_COOLDOWN_MS).toBeGreaterThan(SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS);
  });

  it("leaves an ordinary 429 on the backoff schedule", () => {
    const res = checkFallbackError(429, "Rate limit exceeded");
    expect(res.newBackoffLevel).toBe(1);
    expect(res.cooldownMs).toBeLessThan(LONG_CONTEXT_DEPLETION_COOLDOWN_MS);
  });

  it("only applies on 429; the phrase on another status is not reclassified", () => {
    const text = upstreamShapes(MODEL_CREDIT_DEPLETION_MARKERS[0])[0];
    expect(checkFallbackError(400, text)).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("survives a non-string body without throwing", () => {
    for (const bad of [null, undefined, 0, false, {}, [], { error: { message: null } }]) {
      expect(() => isModelCreditDepletion(bad)).not.toThrow();
      expect(isModelCreditDepletion(bad)).toBe(false);
    }
  });
});

describe("model credit 429: relayed, not scrubbed", () => {
  // The scrub list exists only because Claude Code latches
  // longContext1mCreditsBlocked on the long-context wording and clamps the whole
  // session to 200k. This phrase sets no latch, so the caller sees the real cause.
  it("is disjoint from the client latch list", () => {
    for (const marker of MODEL_CREDIT_DEPLETION_MARKERS) {
      expect(LONG_CONTEXT_DEPLETION_MARKERS).not.toContain(marker);
    }
  });

  it.each(MODEL_CREDIT_DEPLETION_MARKERS)("passes %j through the scrubber untouched", (marker) => {
    for (const text of upstreamShapes(marker)) {
      expect(scrubLongContextDepletion(text)).toBe(text);
    }
  });
});

// markAccountUnavailable derives mustWait as `lockClass === 'rate' || 'transient'`
// (src/sse/services/auth.js). A 'rate' class therefore returns the 429 to the
// caller without rotating, which is what the classification fix alone left in
// place: the cooldown lengthened to 120s but chat.js still short-circuited on
// mustWait and the pool of alternates was never tried.
describe("model credit 429: classified as quota so the request rotates", () => {
  const mustWait = (cls) => cls === "rate" || cls === "transient";

  it.each(MODEL_CREDIT_DEPLETION_MARKERS)("classifies %j as quota, not rate", (marker) => {
    for (const text of upstreamShapes(marker)) {
      const cls = classifyAccountFailure(429, text);
      expect(cls).toBe("quota");
      expect(mustWait(cls)).toBe(false);
    }
  });

  it("still classifies an ordinary burst 429 as rate, which does hold the request", () => {
    const cls = classifyAccountFailure(429, "This request would exceed your account's rate limit.");
    expect(cls).toBe("rate");
    expect(mustWait(cls)).toBe(true);
  });

  it("only applies on 429", () => {
    const text = upstreamShapes(MODEL_CREDIT_DEPLETION_MARKERS[0])[0];
    expect(classifyAccountFailure(500, text)).toBe("transient");
  });
});
