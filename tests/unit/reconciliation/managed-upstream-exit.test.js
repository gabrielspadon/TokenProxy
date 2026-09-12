// managed.upstream.exit — managed OpenRouter dispatch equivalent.
//
// boundary-contract.json "managed.upstream.exit": receipt model, endpoint and
// attempt equal assignment. Exercised against resolveTransport /
// credentialAuthMode (open-sse/services/provider.js), the real multi-endpoint
// dispatch pin, checkFallbackError (open-sse/services/accountFallback.js), the
// real retry/backoff classifier, and a real temporary SQLite database for the
// persisted receipt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVisibleTelemetryFixture } from "../../fixtures/visible-telemetry.mjs";

// Public analytics and history deliberately exclude test-origin writes. The
// fixture verifies the origin of the rows each seeding call owns and
// re-identifies only those as a receipted synthetic import, so the public read
// under test stays the real one.
let visibleFixture;
async function withVisibleRows(produce) {
  visibleFixture ||= createVisibleTelemetryFixture(await (await import("@/lib/db/driver.js")).getAdapter(), "managed-upstream-exit");
  return visibleFixture(produce);
}

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolveTransport } from "open-sse/services/provider.js";
import { checkFallbackError, getQuotaCooldown } from "open-sse/services/accountFallback.js";
import { COOLDOWN_MS } from "open-sse/config/errorConfig.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-managed-upstream-"));
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

// Kimi is a real multi-endpoint provider (open-sse/providers/registry/kimi.js,
// #2881): an OAuth (Kimi Code subscription) credential pins to
// api.kimi.com/coding, and an API-key credential pins to the separate
// api.moonshot.ai platform host. The two credential kinds are the two
// different assignments this gate proves stay exactly pinned.
const OAUTH_CREDS = { authType: "oauth", accessToken: "at-fake-not-real" };
const APIKEY_CREDS = { authType: "apikey", apiKey: "sk-fake-not-real" };

describe('managed.upstream.exit: "drop exact endpoint pin" / "permit route fallback"', () => {
  it("resolves the SAME assigned endpoint on every call — no drift, no fallback substitution", () => {
    const urls = Array.from({ length: 5 }, () => resolveTransport("kimi", "openai", OAUTH_CREDS)?.baseUrl);
    expect(new Set(urls).size).toBe(1);
    expect(urls[0]).toBe("https://api.kimi.com/coding/v1/chat/completions");
  });

  it("a different assignment (api-key credential) pins to its OWN endpoint, never the oauth one", () => {
    const oauthUrl = resolveTransport("kimi", "openai", OAUTH_CREDS)?.baseUrl;
    const apiKeyUrl = resolveTransport("kimi", "openai", APIKEY_CREDS)?.baseUrl;
    expect(apiKeyUrl).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(apiKeyUrl).not.toBe(oauthUrl);
  });
});

describe('managed.upstream.exit: "replay paid or partial rate limit" is never a same-connection instant retry', () => {
  it("a paid/exhausted account (402) falls over with a real cooldown, never 0ms", () => {
    const result = checkFallbackError(402, "payment required", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(COOLDOWN_MS.paymentRequired);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("a partial rate limit (429) backs off exponentially — never a flat instant replay", () => {
    let level = 0;
    const cooldowns = [];
    for (let i = 0; i < 4; i += 1) {
      const result = checkFallbackError(429, "rate limit exceeded", level);
      expect(result.shouldFallback).toBe(true);
      expect(result.cooldownMs).toBeGreaterThan(0);
      expect(result.cooldownMs).toBe(getQuotaCooldown(result.newBackoffLevel));
      cooldowns.push(result.cooldownMs);
      level = result.newBackoffLevel;
    }
    // Strictly increasing until the cap — a connection hit repeatedly waits
    // longer each time rather than being replayed at a constant interval.
    for (let i = 1; i < cooldowns.length; i += 1) {
      expect(cooldowns[i]).toBeGreaterThan(cooldowns[i - 1]);
    }
  });
});

describe("managed.upstream.exit: receipt model, endpoint and attempt equal assignment (live_gate)", () => {
  it("the persisted receipt records exactly the assigned model and endpoint — never a substituted one", async () => {
    const assignment = {
      provider: "kimi",
      model: "k3",
      connectionId: "managed-exact-pin-conn",
      endpoint: resolveTransport("kimi", "openai", OAUTH_CREDS)?.baseUrl,
    };
    await withVisibleRows(() => db.saveRequestUsage({ ...assignment, tokens: { prompt_tokens: 200, completion_tokens: 60 } }));

    const hist = await db.getUsageHistory({ provider: "kimi" });
    const row = hist.find((h) => h.connectionId === assignment.connectionId);
    expect(row.model).toBe(assignment.model);
    expect(row.endpoint).toBe(assignment.endpoint);
  });

  it("two different attempts never merge into one receipt — each keeps its own endpoint", async () => {
    const base = { provider: "kimi", model: "k3", tokens: { prompt_tokens: 10, completion_tokens: 5 } };
    await withVisibleRows(async () => {
      await db.saveRequestUsage({
        ...base,
        connectionId: "managed-attempt-a",
        endpoint: "https://api.kimi.com/coding/v1/chat/completions",
      });
      await db.saveRequestUsage({
        ...base,
        connectionId: "managed-attempt-b",
        endpoint: "https://api.moonshot.ai/v1/chat/completions",
      });
    });

    const hist = await db.getUsageHistory({ provider: "kimi" });
    const a = hist.find((h) => h.connectionId === "managed-attempt-a");
    const b = hist.find((h) => h.connectionId === "managed-attempt-b");
    expect(a.endpoint).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(b.endpoint).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(a.endpoint).not.toBe(b.endpoint);
  });
});
