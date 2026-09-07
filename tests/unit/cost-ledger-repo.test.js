import { describe, it, expect, beforeAll } from "vitest";

import { getAdapter } from "@/lib/db/driver.js";
import {
  computeCostLedgerEntry,
  estimateBaselineTokens,
  recordCostLedger,
  recordCostLedgerForRequest,
  sumSavedUsdSince,
} from "@/lib/db/repos/costLedgerRepo.js";
import { SCHEMA_VERSION } from "@/lib/db/schema.js";
import { COST_LEDGER_TABLES } from "@/lib/db/costLedgerSchema.js";

describe("costLedger schema registration", () => {
  it("retains attribution and completion bindings from schema version 21", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
    expect(COST_LEDGER_TABLES.costLedger).toBeDefined();
    expect(COST_LEDGER_TABLES.costLedger.columns.saverSavedUsd).toBeDefined();
    expect(COST_LEDGER_TABLES.costLedger.columns.cacheSavedUsd).toBeDefined();
    expect(COST_LEDGER_TABLES.costLedger.columns.completionId).toBeDefined();
  });
});

describe("estimateBaselineTokens", () => {
  it("tokenizes at 4 chars/token, rounded up", () => {
    expect(estimateBaselineTokens("x".repeat(4000))).toBe(1000);
    expect(estimateBaselineTokens("x".repeat(4001))).toBe(1001);
    expect(estimateBaselineTokens("")).toBeNull();
    expect(estimateBaselineTokens(null)).toBeNull();
  });
});

describe("computeCostLedgerEntry", () => {
  it.each([
    { prompt_tokens:100,cached_tokens:150,cache_creation_input_tokens:0,completion_tokens:20 },
    { prompt_tokens:100,cached_tokens:50,cache_creation_input_tokens:60,completion_tokens:20 },
    { prompt_tokens:100.5,cached_tokens:0,completion_tokens:20 },
    { prompt_tokens:100,cached_tokens:-1,completion_tokens:20 },
  ])('refuses inconsistent or invalid canonical cache accounting %#', async usage => {
    expect(await computeCostLedgerEntry({rid:'invalid-cache',provider:'openai',model:'gpt-4o',preSaverSerialized:'x'.repeat(400),usage})).toBeNull();
  });
  it("costs the baseline as fully uncached and the actual with cache rates", async () => {
    // gpt-4o: input 2.5, output 10.0, cached 1.25, cache_creation 2.5 (per 1M).
    const entry = await computeCostLedgerEntry({
      rid: "rid00001",
      sid: "abcd1234",
      provider: "openai",
      model: "gpt-4o",
      preSaverSerialized: "x".repeat(4000), // 1000 baseline tokens
      usage: { prompt_tokens: 1000, cached_tokens: 400, cache_creation_input_tokens: 100, completion_tokens: 200 },
      now: "2026-09-06T00:00:00.000Z",
    });
    expect(entry).not.toBeNull();
    expect(entry.baselineUsd).toBeCloseTo((1000 * 2.5 + 200 * 10.0) / 1e6, 12);
    expect(entry.actualUsd).toBeCloseTo((500 * 2.5 + 400 * 1.25 + 100 * 2.5 + 200 * 10.0) / 1e6, 12);
    expect(entry.savedUsd).toBeCloseTo(entry.baselineUsd - entry.actualUsd, 12);
    expect(entry.savedUsd).toBeGreaterThan(0);
    // Attribution split: baseline body size == actual prompt size here, so the
    // saver component is exactly zero and the whole saving is the cache
    // discount (400 read tokens at 1.25 instead of 2.5).
    expect(entry.saverSavedUsd).toBe(0);
    expect(entry.cacheSavedUsd).toBeCloseTo((400 * (2.5 - 1.25)) / 1e6, 12);
    expect(entry.savedUsd).toBeCloseTo(entry.saverSavedUsd + entry.cacheSavedUsd, 12);
    expect(entry.inputTokens).toBe(1000);
    expect(entry.cacheReadTokens).toBe(400);
    expect(entry.cacheWriteTokens).toBe(100);
    expect(entry.outputTokens).toBe(200);
    expect(entry.id).toBe("rid00001");
    expect(entry.sid).toBe("abcd1234");
    expect(entry.ts).toBe("2026-09-06T00:00:00.000Z");
  });

  it("skips unknown models (no rate card), never guessing", async () => {
    const entry = await computeCostLedgerEntry({
      rid: "rid00002",
      provider: "openai",
      model: "no-such-model-xyz",
      preSaverSerialized: "x".repeat(4000),
      usage: { prompt_tokens: 1000, completion_tokens: 10 },
    });
    expect(entry).toBeNull();
  });

  it("skips estimated usage (not provider-reported)", async () => {
    const entry = await computeCostLedgerEntry({
      rid: "rid00003",
      provider: "openai",
      model: "gpt-4o",
      preSaverSerialized: "x".repeat(4000),
      usage: { prompt_tokens: 1000, completion_tokens: 10, estimated: true },
    });
    expect(entry).toBeNull();
  });

  it("skips a provider-reported zero-zero usage as unmeasurable", async () => {
    const entry = await computeCostLedgerEntry({
      rid: "rid00006",
      provider: "openai",
      model: "gpt-4o",
      preSaverSerialized: "x".repeat(4000),
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
    expect(entry).toBeNull();
    // Zero on one side only is still a measurement.
    const half = await computeCostLedgerEntry({
      rid: "rid00007",
      provider: "openai",
      model: "gpt-4o",
      preSaverSerialized: "x".repeat(4000),
      usage: { prompt_tokens: 500, completion_tokens: 0 },
    });
    expect(half).not.toBeNull();
  });

  it("skips missing rid/model/body/usage", async () => {
    const base = {
      rid: "rid00004", provider: "openai", model: "gpt-4o",
      preSaverSerialized: "x".repeat(4000),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    };
    expect(await computeCostLedgerEntry({ ...base, rid: "" })).toBeNull();
    expect(await computeCostLedgerEntry({ ...base, model: "" })).toBeNull();
    expect(await computeCostLedgerEntry({ ...base, preSaverSerialized: "" })).toBeNull();
    expect(await computeCostLedgerEntry({ ...base, usage: null })).toBeNull();
  });

  it("attributes a shrunk body to the saver component, not the cache one", async () => {
    // Baseline 1000 tokens, but the provider billed only 500 uncached input:
    // the delta is saver work. No cache fields -> cacheSavedUsd is zero.
    const entry = await computeCostLedgerEntry({
      rid: "rid00008",
      provider: "openai",
      model: "gpt-4o",
      preSaverSerialized: "x".repeat(4000), // 1000 baseline tokens
      usage: { prompt_tokens: 500, completion_tokens: 100 },
    });
    expect(entry.saverSavedUsd).toBeCloseTo(((1000 - 500) * 2.5) / 1e6, 12);
    expect(entry.cacheSavedUsd).toBe(0);
    expect(entry.savedUsd).toBeCloseTo(entry.saverSavedUsd, 12);
  });

  it("reports saver growth honestly when savers grew the body", async () => {
    // Baseline 100 tokens, provider billed 500 input: negative saver delta.
    const entry = await computeCostLedgerEntry({
      rid: "rid00009",
      provider: "openai",
      model: "gpt-4o",
      preSaverSerialized: "x".repeat(400), // 100 baseline tokens
      usage: { prompt_tokens: 500, completion_tokens: 100 },
    });
    expect(entry.saverSavedUsd).toBeLessThan(0);
    expect(entry.savedUsd).toBeCloseTo(entry.saverSavedUsd + entry.cacheSavedUsd, 12);
  });

  it("canonicalizes raw provider usage spellings before costing", async () => {
    // Anthropic exclusive accounting: prompt excludes cache, folds in.
    const entry = await computeCostLedgerEntry({
      rid: "rid00005",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      preSaverSerialized: "x".repeat(4000),
      usage: {
        prompt_tokens: 500, // excludes cache
        completion_tokens: 100,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 200,
      },
    });
    expect(entry.inputTokens).toBe(1000); // 500 + 300 + 200
    expect(entry.cacheReadTokens).toBe(300);
    expect(entry.cacheWriteTokens).toBe(200);
  });
});

describe("recordCostLedger + sumSavedUsdSince", () => {
  let db;
  beforeAll(async () => {
    db = await getAdapter(); // auto-sync creates costLedger from TABLES
  });

  it("persists, upserts on rid conflict, and rolls up per sid with the saver/cache split", async () => {
    const since = "2026-09-06T00:00:00.000Z";
    const mk = (id, saverSavedUsd, cacheSavedUsd = 0, ts = "2026-09-06T01:00:00.000Z") => {
      const savedUsd = saverSavedUsd + cacheSavedUsd;
      return {
        id, ts, sid: "cafe0001", provider: "openai", model: "gpt-4o",
        baselineUsd: 0.002, actualUsd: 0.002 - savedUsd, savedUsd,
        saverSavedUsd, cacheSavedUsd,
        inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100,
      };
    };

    expect(await recordCostLedger(mk("ridA0001", 0.001))).toBe(true);
    expect(await recordCostLedger(mk("ridA0002", 0.002, 0.0005))).toBe(true);
    let total = await sumSavedUsdSince("cafe0001", since);
    expect(total.saverSavedUsd).toBeCloseTo(0.003, 12);
    expect(total.cacheSavedUsd).toBeCloseTo(0.0005, 12);

    // Same rid again: upsert replaces, does not double-count.
    expect(await recordCostLedger(mk("ridA0002", 0.004))).toBe(true);
    total = await sumSavedUsdSince("cafe0001", since);
    expect(total.saverSavedUsd).toBeCloseTo(0.005, 12);
    expect(total.cacheSavedUsd).toBe(0);

    // Negative saverSavedUsd (savers grew the body) is stored honestly.
    expect(await recordCostLedger(mk("ridA0003", -0.001))).toBe(true);
    total = await sumSavedUsdSince("cafe0001", since);
    expect(total.saverSavedUsd).toBeCloseTo(0.004, 12);

    // Other sid and older window do not leak in.
    expect(await recordCostLedger({ ...mk("ridB0001", 0.5), sid: "beef0002" })).toBe(true);
    total = await sumSavedUsdSince("cafe0001", since);
    expect(total.saverSavedUsd).toBeCloseTo(0.004, 12);
    expect(await sumSavedUsdSince("cafe0001", "2026-09-07T00:00:00.000Z")).toEqual({
      saverSavedUsd: 0,
      cacheSavedUsd: 0,
    });

    const row = db.get(`SELECT * FROM costLedger WHERE id = ?`, ["ridA0002"]);
    expect(row.savedUsd).toBeCloseTo(0.004, 12);
    expect(row.saverSavedUsd).toBeCloseTo(0.004, 12);
    expect(row.cacheSavedUsd).toBe(0);
    expect(row.sid).toBe("cafe0001");
  });

  it("returns null for bad inputs instead of a fake zero", async () => {
    expect(await sumSavedUsdSince("", "2026-09-06T00:00:00.000Z")).toBeNull();
    expect(await sumSavedUsdSince("cafe0001", "")).toBeNull();
  });
});

describe("recordCostLedgerForRequest", () => {
  it("writes one row end-to-end and skips unpriceable requests", async () => {
    const entry = await recordCostLedgerForRequest({
      rid: "ridC0001",
      sid: "cafe0001",
      provider: "openai",
      model: "gpt-4o",
      preSaverSerialized: "x".repeat(4000),
      usage: { prompt_tokens: 1000, cached_tokens: 400, completion_tokens: 100 },
      now: "2026-09-06T02:00:00.000Z",
    });
    expect(entry).not.toBeNull();
    expect(entry.savedUsd).toBeGreaterThan(0);

    const skipped = await recordCostLedgerForRequest({
      rid: "ridC0002",
      provider: "openai",
      model: "no-such-model-xyz",
      preSaverSerialized: "x".repeat(4000),
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    });
    expect(skipped).toBeNull();
  });
});
