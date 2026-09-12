// G2 cache truth. Cache READ and cache WRITE aliases resolve at exactly ONE
// place — resolveCacheTokens, called only by canonicalizeUsage — and the two
// canonical fields it produces (cached_tokens, cache_creation_input_tokens)
// carry unchanged through the request record, the per-account aggregate, the
// daily aggregate and the cost computation. Before this, `cache_write_tokens`
// matched no reader at all (those writes were silently zeroed), the daily and
// per-account buckets carried no cache-write field, and two read sites in
// usageRepo re-derived cache reads from raw aliases — a second normalization
// point that drifts the moment a provider adds a spelling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  canonicalizeUsage,
  resolveCacheTokens,
} from "../../../open-sse/utils/usageTracking.js";
import { calculateCostFromTokens } from "../../../open-sse/providers/pricing.js";

const usageRepoSource = fs.readFileSync(
  new URL("../../../src/lib/db/repos/usageRepo.js", import.meta.url),
  "utf8",
);

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-g2-cache-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Every spelling below describes the SAME exchange: 100 fresh input tokens,
// 200 read from cache, 30 written to cache, 50 out. Anthropic-style spellings
// are cache-EXCLUSIVE (prompt omits both cache quantities); OpenAI-style
// `cached_tokens` is cache-INCLUSIVE (prompt already counts the read).
// Keyed by an id whose FIRST EIGHT characters are unique: getUsageStats falls
// back to `Account ${connId.slice(0, 8)}...` for an unmapped connection and
// keys byAccount on that, so ids sharing a prefix would merge into one bucket
// and the per-account assertions would read another spelling's tokens.
const EXCLUSIVE_SPELLINGS = {
  "anthropic canonical": {
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 30,
  },
  "cache_write_tokens spelling": {
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_input_tokens: 200,
    cache_write_tokens: 30,
  },
  "cache_read_tokens spelling": {
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_tokens: 200,
    cache_write_input_tokens: 30,
  },
  "cache_creation_tokens spelling": {
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_tokens: 200,
    cache_creation_tokens: 30,
  },
};

const SPELLING_IDS = {
  "anthropic canonical": "g2read-a",
  "cache_write_tokens spelling": "g2write-b",
  "cache_read_tokens spelling": "g2altrd-c",
  "cache_creation_tokens spelling": "g2creat-d",
};

describe("G2 cache aliases resolve at one point", () => {
  it.each(Object.entries(EXCLUSIVE_SPELLINGS))(
    "%s produces the same canonical pair",
    (_label, raw) => {
      const c = canonicalizeUsage(raw);
      expect(c.cached_tokens).toBe(200);
      expect(c.cache_creation_input_tokens).toBe(30);
      // Exclusive prompt is folded up so prompt_tokens is cache-INCLUSIVE.
      expect(c.prompt_tokens).toBe(330);
    },
  );

  it("keeps an inclusive prompt inclusive rather than double-counting it", () => {
    const c = canonicalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      cached_tokens: 600,
    });
    expect(c.prompt_tokens).toBe(1000);
    expect(c.cached_tokens).toBe(600);
  });

  it("reads a nested cache write that carries no top-level alias", () => {
    const resolved = resolveCacheTokens({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 200, cache_creation_tokens: 30 },
    });
    expect(resolved.read).toBe(200);
    expect(resolved.write).toBe(30);
    expect(resolved.inclusive).toBe(true);
  });

  it("resolves a cache write arriving with no cache read", () => {
    const c = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_write_tokens: 30,
    });
    expect(c.cache_creation_input_tokens).toBe(30);
    expect(c.prompt_tokens).toBe(130);
  });

  it("normalizes exactly once — canonicalizing twice is a fixed point", () => {
    for (const raw of Object.values(EXCLUSIVE_SPELLINGS)) {
      const once = canonicalizeUsage(raw);
      const twice = canonicalizeUsage({ ...once });
      expect(twice.prompt_tokens).toBe(once.prompt_tokens);
      expect(twice.cached_tokens).toBe(once.cached_tokens);
      expect(twice.cache_creation_input_tokens).toBe(
        once.cache_creation_input_tokens,
      );
    }
  });

  it("has no second normalization point in the aggregates", () => {
    // A read site that re-derives a canonical value from a raw provider alias
    // is a normalization point of its own, and drifts the moment a provider
    // adds a spelling that only usageTracking knows about.
    expect(usageRepoSource).not.toMatch(/cache_read_input_tokens/);
    // Word-anchored: the guard bans the RAW provider aliases, not the presence
    // fields (cache_read_tokens_present) usageRepo legitimately stamps.
    expect(usageRepoSource).not.toMatch(/cache_read_tokens\b/);
    expect(usageRepoSource).not.toMatch(/cache_write_tokens\b/);
    expect(usageRepoSource).not.toMatch(/cache_write_input_tokens/);
    expect(usageRepoSource).not.toMatch(/cache_creation_tokens/);
  });
});

describe("G2 canonical cache values carry through every consumer", () => {
  it.each(Object.entries(EXCLUSIVE_SPELLINGS))(
    "%s reaches record, account, daily and cost identically",
    async (label, raw) => {
      const connectionId = `${SPELLING_IDS[label]}-conn`;
      const model = "claude-sonnet-4-6";
      // Deliberately NOT pre-canonicalized: saveRequestUsage is the boundary
      // that normalizes, so a caller handing it raw provider usage must produce
      // the same rows as one that canonicalized first.
      await db.saveRequestUsage({
        provider: "anthropic",
        model,
        connectionId,
        tokens: { ...raw },
        endpoint: "/v1/messages",
        status: "ok",
      });

      // 1. Request record.
      const hist = await db.getUsageHistory({ provider: "anthropic" });
      const row = hist.find((h) => h.connectionId === connectionId);
      expect(row.tokens.cached_tokens).toBe(200);
      expect(row.tokens.cache_creation_input_tokens).toBe(30);
      expect(row.tokens.prompt_tokens).toBe(330);

      const stats = await db.getUsageStats("24h");

      // 2. Per-account aggregate.
      const account = Object.values(stats.byAccount).find(
        (a) => a.connectionId === connectionId,
      );
      expect(account.cachedTokens).toBe(200);
      expect(account.cacheCreationTokens).toBe(30);

      // 3. Cost, off the canonical names only.
      const expected =
        (100 * 3 + 200 * 0.3 + 30 * 3.75 + 50 * 15) / 1_000_000;
      expect(row.cost).toBeCloseTo(expected, 12);
      expect(
        calculateCostFromTokens(row.tokens, {
          input: 3,
          cached: 0.3,
          cache_creation: 3.75,
          output: 15,
        }),
      ).toBeCloseTo(expected, 12);
    },
  );

  it("sums cache reads and writes across every spelling in the daily totals", async () => {
    // 4. Daily aggregate. All four spellings above landed on the same day, so
    // the totals are the per-request quantities times the number of spellings.
    const stats = await db.getUsageStats("24h");
    const n = Object.keys(EXCLUSIVE_SPELLINGS).length;
    expect(stats.totalCachedTokens).toBe(200 * n);
    expect(stats.totalCacheCreationTokens).toBe(30 * n);
    expect(stats.byProvider.anthropic.cachedTokens).toBe(200 * n);
    expect(stats.byProvider.anthropic.cacheCreationTokens).toBe(30 * n);
  });
});
