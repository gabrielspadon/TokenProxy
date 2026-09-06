import { describe, it, expect } from "vitest";
import { checkFallbackError, getQuotaCooldown } from "open-sse/services/accountFallback.js";
import { TRANSIENT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";

describe("accountFallback: checkFallbackError rules", () => {
  describe("pass: true client-side errors (context length exceeded)", () => {
    it("does not fallback or lock account when message contains 'maximum context length'", () => {
      const res = checkFallbackError(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.");
      expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    });

    it("does not fallback or lock account when message contains 'context_length_exceeded'", () => {
      const res = checkFallbackError(400, JSON.stringify({ error: { code: "context_length_exceeded", message: "Too many tokens" } }));
      expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    });

    it("does not fallback or lock account when message contains 'prompt is too long'", () => {
      const res = checkFallbackError(400, "The prompt is too long for the requested model.");
      expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    });

    it("does not fallback or lock account on status 400 (Bad Request)", () => {
      const res = checkFallbackError(400, "Bad Request");
      expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    });

    it("does not fallback or lock account when message contains 'invalid_request_error'", () => {
      const res = checkFallbackError(400, JSON.stringify({ error: { type: "invalid_request_error", message: "tools[0].function.parameters is invalid" } }));
      expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    });

    it("does not fallback or lock account when message contains 'improperly formed request'", () => {
      const res = checkFallbackError(400, "Improperly formed request");
      expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    });

    it("does not fallback or lock account when message contains 'unsupported parameter'", () => {
      const res = checkFallbackError(400, "Unsupported parameter: reasoning_effort");
      expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    });

    it("does not fallback or lock account for a generic HTTP 422 request error", () => {
      const res = checkFallbackError(422, "The request body cannot be processed");
      expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    });
  });

  describe("standard rate-limit and auth error rules", () => {
    it("handles 401 unauthorized with fixed long cooldown", () => {
      const res = checkFallbackError(401, "Unauthorized");
      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBeGreaterThan(0);
    });

    it("handles rate limit (429) with exponential backoff", () => {
      const res1 = checkFallbackError(429, "Too many requests", 0);
      expect(res1.shouldFallback).toBe(true);
      expect(res1.newBackoffLevel).toBe(1);
      expect(res1.cooldownMs).toBe(getQuotaCooldown(1));

      const res2 = checkFallbackError(429, "rate limit", 1);
      expect(res2.shouldFallback).toBe(true);
      expect(res2.newBackoffLevel).toBe(2);
      expect(res2.cooldownMs).toBe(getQuotaCooldown(2));
    });

    // Overload is not depletion. A 529/503 is the provider's capacity, not
    // this key's quota: the cooldown stays inside the same-account retry
    // ceiling (chat.js SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS) so the loop retries
    // the SAME account before rotating, and a rotation that would spend a
    // prompt-cache write on the next account is the last resort, not the first.
    it.each([
      [529, "Overloaded", getQuotaCooldown(1)],
      [503, "Service Unavailable", TRANSIENT_COOLDOWN_MS],
    ])("keeps a %s %s on the same account with a short cooldown, not a quota lock", (status, text, cooldownMs) => {
      const res = checkFallbackError(status, text, 0);
      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBe(cooldownMs);
      expect(res.cooldownMs).toBeLessThan(30 * 1000);
    });

    it("returns transient cooldown for unknown errors", () => {
      const res = checkFallbackError(500, "Internal server glitch");
      expect(res).toEqual({ shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS });
    });

    it.each([
      ["rate limit", "rate limit exceeded"],
      ["capacity", "upstream capacity is exhausted"],
      ["overloaded", "the service is overloaded"],
    ])("keeps text-signaled 422 %s errors eligible for fallback", (_kind, message) => {
      const res = checkFallbackError(422, message, 1);
      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBe(getQuotaCooldown(2));
      expect(res.newBackoffLevel).toBe(2);
    });
  });
});
