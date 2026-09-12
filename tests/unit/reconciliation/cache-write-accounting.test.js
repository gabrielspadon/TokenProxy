// docs/reconciliation/issues/07-cache-write-accounting.md.
//
// The ingestion-side normalization (resolveCacheTokens/canonicalizeUsage
// recognizing cache_write_tokens, and request/account/daily/cost aggregates
// reading the canonical field rather than re-deriving it) is already proven
// by cache-accounting.test.js — that suite covers the four alias spellings
// end to end through the real DB. This file covers what that one does not:
// the toResponsesUsage export path, which dropped cache-creation entirely
// (issue 07's specific regression), the failure direction on a malformed
// cache field, and the account-switch case where a cache-read drop must stay
// visible per-account rather than blending into one number.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  canonicalizeUsage,
} from "../../../open-sse/utils/usageTracking.js";
import { toResponsesUsage } from "../../../open-sse/translator/concerns/usage.js";
import { createVisibleTelemetryFixture } from '../../fixtures/visible-telemetry.mjs';

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let switches;
let visibleFixture;
const saveVisibleUsage = entry => visibleFixture(() => db.saveRequestUsage(entry));

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-cache-write-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  switches = await import("@/lib/db/repos/accountSwitchRepo.js");
  await db.initDb();
  visibleFixture = createVisibleTelemetryFixture(await (await import('../../../src/lib/db/driver.js')).getAdapter(), 'cache-write-accounting');
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// The same exchange (100 fresh input, 200 read from cache, 30 written to
// cache, 50 out), spelled three ways per the issue doc's Vitest translation:
// top-level cache_creation_input_tokens, the nested prompt_tokens_details
// form, and cache_write_tokens — the spelling no reader handled before.
const CACHE_WRITE_SPELLINGS = {
  "top-level cache_creation_input_tokens": {
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 30,
  },
  "nested prompt_tokens_details.cache_creation_tokens": {
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_input_tokens: 200,
    prompt_tokens_details: { cache_creation_tokens: 30 },
  },
  "cache_write_tokens (previously unhandled)": {
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_input_tokens: 200,
    cache_write_tokens: 30,
  },
};

// First-eight-character-distinct ids: getUsageStats falls back to
// `Account ${connId.slice(0, 8)}...` for an unmapped connection and keys
// byAccount on that string, so ids sharing an 8-char prefix silently merge
// into one bucket and the per-spelling assertions below would blend.
const CACHE_WRITE_IDS = {
  "top-level cache_creation_input_tokens": "cwtop001-conn",
  "nested prompt_tokens_details.cache_creation_tokens": "cwnest002-conn",
  "cache_write_tokens (previously unhandled)": "cwraw0003-conn",
};

describe("cache-write aliases normalize to the identical canonical pair", () => {
  it("all three spellings produce byte-identical canonicalizeUsage output", () => {
    const canonical = Object.values(CACHE_WRITE_SPELLINGS).map((raw) => canonicalizeUsage(raw));
    for (const c of canonical) expect(c).toEqual(canonical[0]);
    expect(canonical[0].cached_tokens).toBe(200);
    expect(canonical[0].cache_creation_input_tokens).toBe(30);
    expect(canonical[0].prompt_tokens).toBe(330);
  });

  it("carries the cache-creation figure into the Responses-API shape for every spelling", () => {
    // Regression check for issue 07: toResponsesUsage used to read only
    // cached_tokens and drop cache-creation evidence entirely.
    for (const raw of Object.values(CACHE_WRITE_SPELLINGS)) {
      const canonical = canonicalizeUsage(raw);
      const responses = toResponsesUsage(canonical);
      expect(responses.input_tokens_details).toEqual({
        cached_tokens: 200,
        cache_creation_tokens: 30,
      });
    }
  });

  it("still reads a raw (non-canonicalized) payload through the same shared resolver", () => {
    // toResponsesUsage is not only fed pre-canonicalized usage — a caller
    // may hand it a raw provider shape directly, and the fix must resolve
    // aliases there too rather than only on canonicalizeUsage's own output.
    for (const raw of Object.values(CACHE_WRITE_SPELLINGS)) {
      const responses = toResponsesUsage(raw);
      expect(responses.input_tokens_details).toEqual({
        cached_tokens: 200,
        cache_creation_tokens: 30,
      });
    }
  });

  it("produces identical per-account cache-write totals across all three spellings", async () => {
    const model = "claude-sonnet-4-6";
    for (const [label, raw] of Object.entries(CACHE_WRITE_SPELLINGS)) {
      await saveVisibleUsage({
        provider: "anthropic",
        model,
        connectionId: CACHE_WRITE_IDS[label],
        tokens: { ...raw },
        endpoint: "/v1/messages",
        status: "ok",
      });
    }

    const stats = await db.getUsageStats("24h");
    const accounts = Object.values(CACHE_WRITE_IDS).map((connectionId) =>
      Object.values(stats.byAccount).find((a) => a.connectionId === connectionId)
    );
    for (const account of accounts) {
      expect(account.cachedTokens).toBe(200);
      expect(account.cacheCreationTokens).toBe(30);
    }

    // Daily aggregate: nothing else has written to this temp DB yet, so the
    // total is exactly the three spellings' identical contribution summed.
    expect(stats.totalCacheCreationTokens).toBe(30 * Object.keys(CACHE_WRITE_SPELLINGS).length);
    expect(stats.totalCachedTokens).toBe(200 * Object.keys(CACHE_WRITE_SPELLINGS).length);
  });
});

describe("malformed cache fields fail toward zero, never NaN or the wrong bucket", () => {
  it("a non-numeric cache-write value drops to zero without polluting the read count or NaN-ing prompt_tokens", () => {
    const c = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: "not-a-number",
    });
    expect(c.cache_creation_input_tokens).toBe(0);
    expect(c.cached_tokens).toBe(200);
    expect(c.prompt_tokens).toBe(300);
  });

  it("a null or malformed cache-write field never reaches the Responses-API output, and cached_tokens is unaffected", () => {
    const withNull = toResponsesUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cached_tokens: 40,
      cache_creation_input_tokens: null,
    });
    expect(withNull.input_tokens_details).toEqual({ cached_tokens: 40 });

    const withBadType = toResponsesUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cached_tokens: 40,
      cache_creation_input_tokens: "thirty",
    });
    expect(withBadType.input_tokens_details).toEqual({ cached_tokens: 40 });
  });
});

describe("account switch keeps a cache-read drop visible instead of blending it", () => {
  const model = "claude-sonnet-4-6";
  const sessionHash =
    "sha256:cwswitch0000000000000000000000000000000000000000000000000000";
  // Distinct 8-char prefixes (cwsw-frm / cwsw-dst), see the collision note above.
  const fromConnectionId = "cwsw-frm-conn";
  const toConnectionId = "cwsw-dst-conn";

  it("surfaces both the switch receipt and the post-switch cache miss in the same window", async () => {
    // getUsageStats("24h") filters on Date.now() minus 24h, so the pair
    // must be real-clock-relative rather than a fixed calendar date.
    const beforeSwitch = new Date().toISOString();
    const afterSwitch = new Date(Date.now() + 5 * 60_000).toISOString();

    // Pre-switch: the outgoing account has a warm cache.
    await saveVisibleUsage({
      provider: "anthropic",
      model,
      connectionId: fromConnectionId,
      tokens: { prompt_tokens: 100, completion_tokens: 50, cache_read_input_tokens: 500 },
      endpoint: "/v1/messages",
      status: "ok",
      timestamp: beforeSwitch,
    });

    const receipt = await switches.recordSwitch({
      sessionHash,
      model,
      fromConnectionId,
      toConnectionId,
      trigger: "exhaustion",
      reason: "pinned-window-exhausted",
      switchedAt: afterSwitch,
    });
    expect(receipt.id).toBeTruthy();

    // Immediately after: first request on the new account is a cache miss —
    // zero read, full cache-creation cost for the same-size content.
    await saveVisibleUsage({
      provider: "anthropic",
      model,
      connectionId: toConnectionId,
      tokens: { prompt_tokens: 100, completion_tokens: 50, cache_creation_input_tokens: 500 },
      endpoint: "/v1/messages",
      status: "ok",
      timestamp: afterSwitch,
    });

    // The switch event is durable and findable from either side.
    const listed = await switches.listSwitches({ sessionHash });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ fromConnectionId, toConnectionId, trigger: "exhaustion" });

    // Per-request granularity: the drop from 500 read to 0 read is two
    // distinct rows, not one blended figure.
    const hist = await db.getUsageHistory({ provider: "anthropic" });
    const fromRow = hist.find((h) => h.connectionId === fromConnectionId);
    const toRow = hist.find((h) => h.connectionId === toConnectionId);
    expect(fromRow.tokens.cached_tokens).toBe(500);
    expect(fromRow.tokens.cache_creation_input_tokens).toBe(0);
    expect(toRow.tokens.cached_tokens).toBe(0);
    expect(toRow.tokens.cache_creation_input_tokens).toBe(500);

    // Per-account aggregate: each account's own bucket reflects its own
    // reality — 500/0 and 0/500 — never averaged into 250/250.
    const stats = await db.getUsageStats("24h");
    const fromAccount = Object.values(stats.byAccount).find((a) => a.connectionId === fromConnectionId);
    const toAccount = Object.values(stats.byAccount).find((a) => a.connectionId === toConnectionId);
    expect(fromAccount.cachedTokens).toBe(500);
    expect(fromAccount.cacheCreationTokens).toBe(0);
    expect(toAccount.cachedTokens).toBe(0);
    expect(toAccount.cacheCreationTokens).toBe(500);
  });
});
