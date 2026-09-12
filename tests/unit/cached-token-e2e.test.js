// End-to-end: a cache-bearing request flows through canonicalizeUsage →
// saveRequestUsage → getUsageStats, proving cached tokens are persisted,
// aggregated, and cost is computed correctly (the bug this branch fixes).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { createVisibleTelemetryFixture } from '../fixtures/visible-telemetry.mjs';

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let visibleFixture;
const saveVisibleUsage = entry => visibleFixture(() => db.saveRequestUsage(entry));

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-cached-e2e-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  visibleFixture = createVisibleTelemetryFixture(await (await import('../../src/lib/db/driver.js')).getAdapter(), 'cached-token-e2e');
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("cached-token end-to-end (persist + aggregate + cost)", () => {
  it("Claude cache usage: canonical prompt is inclusive, cached persisted, cost correct", async () => {
    // This pre-existing synthetic row must remain hidden when the owned
    // operation below exposes its single row for public-analytics assertions.
    await db.saveRequestUsage({ provider: 'unexposed-fixture', model: 'fixture-model', connectionId: 'unexposed-fixture',
      tokens: { prompt_tokens: 999, completion_tokens: 1, cached_tokens: 900 }, status: 'ok' });
    const adapter = await (await import('../../src/lib/db/driver.js')).getAdapter();
    expect(adapter.get('SELECT dataOrigin FROM usageHistory WHERE connectionId=?', ['unexposed-fixture']).dataOrigin).toBe('test');
    // Raw Claude usage (cache-EXCLUSIVE prompt): input 100, cache_read 200, cache_creation 30, output 50
    const canonical = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    });
    expect(canonical.prompt_tokens).toBe(330); // inclusive

    await saveVisibleUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      connectionId: "c-cache",
      tokens: canonical,
      endpoint: "/v1/messages",
      status: "ok",
    });

    const stats = await db.getUsageStats("24h");
    expect(stats.totalCachedTokens).toBe(200);
    expect(stats.totalPromptTokens).toBe(330);
    expect(stats.byProvider.anthropic.cachedTokens).toBe(200);
    expect(stats.byProvider['unexposed-fixture']).toBeUndefined();
    expect(adapter.get('SELECT dataOrigin FROM usageHistory WHERE connectionId=?', ['unexposed-fixture']).dataOrigin).toBe('test');

    // Cost: nonCached=330-200-30=100 @3 + cached 200 @0.30 + creation 30 @3.75 + output 50 @15
    const expected = (100 * 3 + 200 * 0.3 + 30 * 3.75 + 50 * 15) / 1_000_000;
    const hist = await db.getUsageHistory({ provider: "anthropic" });
    expect(hist.length).toBe(1);
    expect(hist[0].cost).toBeCloseTo(expected, 12);
    expect(hist[0].tokens.cached_tokens).toBe(200);
    expect(hist[0].tokens.cache_creation_input_tokens).toBe(30);
  });

  it("OpenAI cache usage: inclusive prompt passes through, cached counted once", async () => {
    const canonical = canonicalizeUsage({
      prompt_tokens: 1000,        // already includes cached
      completion_tokens: 200,
      cached_tokens: 600,
    });
    expect(canonical.prompt_tokens).toBe(1000);
    expect(canonical.cached_tokens).toBe(600);

    await saveVisibleUsage({
      provider: "openai",
      model: "gpt-4o",
      connectionId: "c-oai",
      tokens: canonical,
      endpoint: "/v1/chat/completions",
      status: "ok",
    });

    const hist = await db.getUsageHistory({ provider: "openai" });
    expect(hist[0].tokens.prompt_tokens).toBe(1000);
    expect(hist[0].tokens.cached_tokens).toBe(600);
  });

  it("persists a provider exact total when the model has no local price", async () => {
    const canonical = canonicalizeUsage({
      prompt_tokens: 12,
      completion_tokens: 3,
      cost_in_usd: 0.123,
    });

    await saveVisibleUsage({
      provider: "unpriced-provider",
      model: "upstream-priced-model",
      connectionId: "c-exact",
      tokens: canonical,
      endpoint: "/v1/chat/completions",
      status: "ok",
    });

    const history = await db.getUsageHistory({ provider: "unpriced-provider" });
    expect(history).toHaveLength(1);
    expect(history[0].cost).toBeCloseTo(0.123, 12);
    expect(history[0].tokens.cost_in_usd).toBe(0.123);
  });

  it("Today stats count input/output-shaped usage", async () => {
    const before = await db.getUsageStats("today");

    await saveVisibleUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      connectionId: "c-input-output",
      tokens: { input_tokens: 77, output_tokens: 23 },
      endpoint: "/v1/messages",
      status: "ok",
    });

    const after = await db.getUsageStats("today");
    expect(after.totalRequests - before.totalRequests).toBe(1);
    expect(after.totalPromptTokens - before.totalPromptTokens).toBe(77);
    expect(after.totalCompletionTokens - before.totalCompletionTokens).toBe(23);
  });
});
