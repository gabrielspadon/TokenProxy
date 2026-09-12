// subscription.upstream.exit — subscription dispatch equivalent.
//
// boundary-contract.json "subscription.upstream.exit": subscription receipt
// has configured connection and null metered cost. Exercised against
// resolveTransport / credentialAuthMode (open-sse/services/provider.js), the
// real credential-scoped transport split documented at #2881 (an OAuth
// subscription credential never lands on a provider's metered platform host),
// and the real persistence funnel (saveUsageStats / extractUsageFromResponse
// in open-sse/handlers/chatCore/requestDetail.js) through a temporary SQLite
// database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolveTransport, credentialAuthMode } from "open-sse/services/provider.js";
import { createVisibleTelemetryFixture } from "../../fixtures/visible-telemetry.mjs";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let saveUsageStats;
let extractUsageFromResponse;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-subscription-upstream-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ saveUsageStats, extractUsageFromResponse } = await import("open-sse/handlers/chatCore/requestDetail.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Public history deliberately excludes test-origin writes. The fixture verifies
// the origin of the rows this call owns and re-identifies only those as a
// receipted synthetic import, so the public read under test stays the real one.
// The adapter is resolved lazily because the db module is imported after
// vi.resetModules() in beforeAll. saveUsageStats writes fire-and-forget, so the
// raw row is awaited INSIDE the ownership window.
let visibleFixture;
async function waitForRow(connectionId, produce) {
  const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  visibleFixture ||= createVisibleTelemetryFixture(adapter, "subscription-upstream-exit");
  await visibleFixture(async () => {
    produce();
    await vi.waitFor(() => {
      if (!adapter.get("SELECT id FROM usageHistory WHERE connectionId=?", [connectionId])) {
        throw new Error(`row for ${connectionId} not persisted yet`);
      }
    }, { timeout: 2000, interval: 10 });
  });
  const hist = await db.getUsageHistory({});
  const row = hist.find((h) => h.connectionId === connectionId);
  if (!row) throw new Error(`row for ${connectionId} is not visible to public history`);
  return row;
}

// Kimi Code (open-sse/providers/registry/kimi.js, #2881): the OAuth
// subscription credential is scoped away from the metered platform transport.
const OAUTH_CREDS = { authType: "oauth", accessToken: "at-subscription-fake" };

describe('subscription.upstream.exit: "route subscription lane through metered provider"', () => {
  it("an OAuth subscription credential is scoped to the subscription host, never the metered platform host", () => {
    expect(credentialAuthMode(OAUTH_CREDS)).toBe("oauth");
    const claude = resolveTransport("kimi", "claude", OAUTH_CREDS);
    const openai = resolveTransport("kimi", "openai", OAUTH_CREDS);
    expect(claude.baseUrl).toBe("https://api.kimi.com/coding/v1/messages");
    expect(openai.baseUrl).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(claude.baseUrl).not.toContain("moonshot.ai");
    expect(openai.baseUrl).not.toContain("moonshot.ai");
  });

  it("an API-key credential is scoped to the metered platform host, never the subscription host", () => {
    const creds = { authType: "apikey", apiKey: "sk-metered-fake" };
    expect(credentialAuthMode(creds)).toBe("apikey");
    const openai = resolveTransport("kimi", "openai", creds);
    expect(openai.baseUrl).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(openai.baseUrl).not.toContain("api.kimi.com/coding");
  });
});

describe("subscription.upstream.exit: receipt has configured connection and null metered cost (live_gate)", () => {
  it("a subscription connection with no configured per-token price retains unknown cost", async () => {
    const connectionId = "subscription-configured-conn";
    const row = await waitForRow(connectionId, () => saveUsageStats({
      provider: "kimi",
      // Deliberately outside the "kimi-*" PATTERN_PRICING catch-all (verified
      // via getPricingForModel) as well as MODEL_PRICING/PROVIDER_PRICING, so
      // this really exercises "no configured price", not a coincidental match.
      model: "subscription-test-model-zzz",
      tokens: { prompt_tokens: 900, completion_tokens: 300 },
      connectionId,
      silent: true,
    }));
    expect(row.connectionId).toBe(connectionId); // the configured connection, unchanged
    expect(row.cost).toBeNull();
  });
});

describe('subscription.upstream.exit: "accept cross-model response" never lets the provider pick the billed model', () => {
  it("extractUsageFromResponse never returns a model field — nothing for a spoofed response to override", () => {
    const spoofed = { model: "a-completely-different-model", usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const usage = extractUsageFromResponse(spoofed);
    expect(usage).not.toHaveProperty("model");
  });

  it("the receipt bills the ASSIGNED model even when the response usage carries a different one", async () => {
    const connectionId = "subscription-cross-model-conn";
    const assignedModel = "assigned-subscription-model";
    const responseBody = { model: "hostile-substituted-model", usage: { prompt_tokens: 40, completion_tokens: 10 } };
    const usage = extractUsageFromResponse(responseBody);

    const row = await waitForRow(connectionId, () => saveUsageStats({
      provider: "kimi",
      model: assignedModel, // the caller's own assignment, independent of responseBody.model
      tokens: usage,
      connectionId,
      silent: true,
    }));
    expect(row.model).toBe(assignedModel);
    expect(row.model).not.toBe("hostile-substituted-model");
  });
});
