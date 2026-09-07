import { describe, it, expect } from "vitest";

import {
  CACHE_MULTIPLIERS,
  cacheMultiplierFor,
  costForUsage,
} from "../../open-sse/providers/cachePricing.js";

describe("cacheMultiplierFor", () => {
  it("anthropic and claude resolve to the 0.1/1.25 (5m) multipliers", () => {
    for (const p of ["anthropic", "claude", "ANTHROPIC"]) {
      const m = cacheMultiplierFor(p);
      expect(m.read).toBe(0.1);
      expect(m.write).toBe(1.25);
    }
    expect(CACHE_MULTIPLIERS.anthropic.write1h).toBe(2.0);
  });

  it("openai and gemini carry no fallback discount: unstated cache rates degrade to plain pricing", () => {
    // Their discounts are per-model on the rate card; a model without them
    // must not inherit one, or savings would be overstated.
    expect(cacheMultiplierFor("openai")).toEqual({ read: 1.0, write: 1.0 });
    expect(cacheMultiplierFor("gemini")).toEqual({ read: 1.0, write: 1.0 });
    expect(CACHE_MULTIPLIERS.openai).toBeUndefined();
    expect(CACHE_MULTIPLIERS.gemini).toBeUndefined();
  });

  it("unknown providers degrade to plain pricing (1.0/1.0)", () => {
    expect(cacheMultiplierFor("deepseek")).toEqual({ read: 1.0, write: 1.0 });
    expect(cacheMultiplierFor("ollama")).toEqual({ read: 1.0, write: 1.0 });
    expect(cacheMultiplierFor(null)).toEqual({ read: 1.0, write: 1.0 });
    expect(cacheMultiplierFor(undefined)).toEqual({ read: 1.0, write: 1.0 });
  });
});

describe("costForUsage", () => {
  const usage = {
    prompt_tokens: 1000, // cache-inclusive
    cached_tokens: 400,
    cache_creation_input_tokens: 100,
    completion_tokens: 200,
  };

  it("splits a canonical usage into the four billed parts", () => {
    // input 2.0/1M, output 8.0/1M; multipliers read 0.1, write 1.25.
    const parts = costForUsage({
      pricing: { input: 2.0, output: 8.0 },
      usage,
      multipliers: { read: 0.1, write: 1.25 },
    });
    // uncached input = 1000 - 400 - 100 = 500
    expect(parts.uncachedUsd).toBeCloseTo((500 * 2.0) / 1e6, 12);
    // read rate = 2.0 * 0.1 = 0.2/1M
    expect(parts.cacheReadUsd).toBeCloseTo((400 * 0.2) / 1e6, 12);
    // write rate = 2.0 * 1.25 = 2.5/1M
    expect(parts.cacheWriteUsd).toBeCloseTo((100 * 2.5) / 1e6, 12);
    expect(parts.outputUsd).toBeCloseTo((200 * 8.0) / 1e6, 12);
    expect(parts.totalUsd).toBeCloseTo(
      parts.uncachedUsd + parts.cacheReadUsd + parts.cacheWriteUsd + parts.outputUsd,
      12,
    );
  });

  it("explicit per-model cache rates win over multipliers", () => {
    // The OpenAI/Gemini model tables carry `cached`/`cache_creation` directly;
    // those rates apply even when the multiplier says otherwise.
    const parts = costForUsage({
      pricing: { input: 2.5, output: 10.0, cached: 1.25, cache_creation: 2.5 },
      usage,
      multipliers: { read: 0.1, write: 1.25 },
    });
    expect(parts.cacheReadUsd).toBeCloseTo((400 * 1.25) / 1e6, 12);
    expect(parts.cacheWriteUsd).toBeCloseTo((100 * 2.5) / 1e6, 12);
  });

  it("a 0.0 cache rate is a real rate, not a fallback trigger", () => {
    const parts = costForUsage({
      pricing: { input: 2.0, output: 8.0, cached: 0.0 },
      usage,
      multipliers: { read: 0.1, write: 1.25 },
    });
    expect(parts.cacheReadUsd).toBe(0);
  });

  it("default multipliers charge cache tokens at the plain input rate", () => {
    const parts = costForUsage({
      pricing: { input: 2.0, output: 8.0 },
      usage,
    });
    expect(parts.cacheReadUsd).toBeCloseTo((400 * 2.0) / 1e6, 12);
    expect(parts.cacheWriteUsd).toBeCloseTo((100 * 2.0) / 1e6, 12);
  });

  it("clamps cache quantities to the prompt total and negatives to zero", () => {
    const parts = costForUsage({
      pricing: { input: 2.0, output: 8.0 },
      usage: { prompt_tokens: 100, cached_tokens: 400, cache_creation_input_tokens: -50, completion_tokens: -5 },
      multipliers: { read: 0.1, write: 1.25 },
    });
    expect(parts.uncachedUsd).toBe(0);
    expect(parts.cacheReadUsd).toBeCloseTo((400 * 0.2) / 1e6, 12);
    expect(parts.outputUsd).toBe(0);
  });

  it("tolerates a missing usage or pricing", () => {
    expect(costForUsage({}).totalUsd).toBe(0);
    expect(costForUsage({ pricing: { input: 1, output: 1 }, usage: null }).totalUsd).toBe(0);
  });
});
