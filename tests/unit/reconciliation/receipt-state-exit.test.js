// receipt.state.exit — persistGenerationReceipt equivalent.
//
// boundary-contract.json "receipt.state.exit": one redacted receipt exists
// for every non-cache generation. Exercised against the real persistence
// funnel — saveUsageStats (open-sse/handlers/chatCore/requestDetail.js), which
// gates on nonzero tokens before
// delegating to saveRequestUsage (src/lib/db/repos/usageRepo.js) — through a
// real temporary SQLite database, matching the sibling cache-accounting gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let saveUsageStats;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-receipt-state-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ saveUsageStats } = await import("open-sse/handlers/chatCore/requestDetail.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});
import { createVisibleTelemetryFixture } from "../../fixtures/visible-telemetry.mjs";

// Public history deliberately excludes test-origin writes. The fixture verifies
// the origin of the rows each seeding call owns and re-identifies only those as
// a receipted synthetic import, so the public read under test stays the real
// one. The adapter is resolved lazily because the db module is imported after
// vi.resetModules() in beforeAll.
let visibleFixture;
async function withVisibleRows(produce) {
  visibleFixture ||= createVisibleTelemetryFixture(await (await import("@/lib/db/driver.js")).getAdapter(), "receipt-state-exit");
  return visibleFixture(produce);
}

// saveRequestUsage is called fire-and-forget from saveUsageStats (its promise is
// swallowed with .catch, by design — callers on the streaming path cannot block
// on a DB write), so the raw row is awaited INSIDE the ownership window and the
// public read happens after it has been re-identified.
async function waitForRow(connectionId, produce) {
  await withVisibleRows(async () => {
    produce();
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
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

describe("receipt.state.exit — one redacted receipt exists for every non-cache generation", () => {
  it("a real generation (nonzero tokens) gets exactly one persisted receipt", async () => {
    const connectionId = "receipt-real-gen-conn";
    await waitForRow(connectionId, () => saveUsageStats({
      provider: "acme",
      model: "m1",
      tokens: { prompt_tokens: 120, completion_tokens: 40 },
      connectionId,
      endpoint: "/v1/chat/completions",
      silent: true,
    }));
    const hist = await db.getUsageHistory({});
    expect(hist.filter((h) => h.connectionId === connectionId)).toHaveLength(1);
  });

  it("a zero-token event (no generation happened) gets no receipt at all", async () => {
    // The zero-token guard in saveUsageStats returns synchronously, before any
    // async DB call is even queued, so there is nothing to race here.
    const connectionId = "receipt-zero-gen-conn";
    saveUsageStats({
      provider: "acme",
      model: "m1",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      connectionId,
      silent: true,
    });
    const hist = await db.getUsageHistory({});
    expect(hist.filter((h) => h.connectionId === connectionId)).toHaveLength(0);
  });

  it('mutation "persist raw metadata": the raw API key and the translated request body never survive to the row', async () => {
    const connectionId = "receipt-redact-conn";
    const secret = "sk-THIS-MUST-NEVER-BE-PERSISTED-RAW";
    const row = await waitForRow(connectionId, () => saveUsageStats({
      provider: "acme",
      model: "m1",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      connectionId,
      apiKey: secret,
      endpoint: "/v1/messages",
      translatedBody: { messages: [{ role: "user", content: "top secret prompt body" }] },
      silent: true,
    }));
    expect(row.apiKeyMasked).not.toBe(secret);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("top secret prompt body");
  });

  it('mutation "omit provider attempt": the provider, model and endpoint that served this generation survive exactly', async () => {
    const connectionId = "receipt-attempt-conn";
    const row = await waitForRow(connectionId, () => saveUsageStats({
      provider: "acme-provider",
      model: "exact-model",
      tokens: { prompt_tokens: 30, completion_tokens: 15 },
      connectionId,
      endpoint: "/v1/responses",
      silent: true,
    }));
    expect(row.provider).toBe("acme-provider");
    expect(row.model).toBe("exact-model");
    expect(row.endpoint).toBe("/v1/responses");
  });

  it('mutation "trust estimated cost": the recorded count is the same count the client was handed', async () => {
    const connectionId = "receipt-estimate-conn";
    // The harness sizes its context window and its compaction trigger from the
    // usage it is handed, so the recorded number and the client-visible number
    // must be one number. Any divergence here is the harness reasoning from a
    // history it thinks is longer or shorter than it is.
    const usage = { prompt_tokens: 500, completion_tokens: 80, estimated: true };

    const row = await waitForRow(connectionId,
      () => saveUsageStats({ provider: "acme", model: "m1", tokens: usage, connectionId, silent: true }));
    expect(row.tokens.prompt_tokens).toBe(500);
    expect(row.tokens.completion_tokens).toBe(80);
  });
});
