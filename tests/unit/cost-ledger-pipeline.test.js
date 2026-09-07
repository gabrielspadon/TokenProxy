import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Counterfactual dollar ledger end-to-end through handleChatCore with a
// mocked executor (no network). The executor sizes its reported prompt_tokens
// from the body it actually receives, so with savers OFF the baseline equals
// the actual cost, and with savers ON the pre-saver baseline exceeds it.

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  ledgerFail: { current: false },
  saveUsageCalls: [],
}));

// The ledger must never take usage persistence down with it: flip
// ledgerFail.current to make every ledger attempt reject, and assert the
// requestStats completion row still lands.
vi.mock("../../src/lib/db/repos/costLedgerRepo.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    recordCostLedgerForRequest: (...args) =>
      mocks.ledgerFail.current
        ? Promise.reject(new Error("ledger down"))
        : actual.recordCostLedgerForRequest(...args),
  };
});

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: mocks.executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", async (orig) => ({
  ...(await orig()),
  COLORS: { red: "", reset: "" },
}));

// Same mutation contract as real RTK: shrink any long string content.
vi.mock("../../open-sse/rtk/index.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    compressMessages: vi.fn((body, enabled) => {
        if (!enabled) return null;
      for (const m of body.messages || []) {
        if (typeof m?.content === "string" && m.content.length > 500) {
          m.content = "x".repeat(100);
        }
      }
      return { bytesBefore: 2000, bytesAfter: 200, hits: [{ filter: "git_diff" }], filter: "git_diff" };
    }),
  };
});

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => null),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/rtk/pxpipe.js", () => ({
  compressWithPxpipe: vi.fn(async () => ({ body: null, summary: { applied: false, reason: "disabled" } })),
}));

vi.mock("@/lib/usageDb.js", async () => {
  const actual = await vi.importActual("@/lib/usageDb.js");
  return {
    ...actual,
    trackPendingRequest: vi.fn(),
    appendRequestLog: vi.fn(async () => {}),
    saveRequestDetail: vi.fn(async () => {}),
    // Spied passthrough: proves usage persistence runs even when the ledger
    // rejects. (The pending-row handoff is mocked away in this file, so the
    // observable unit is the saveRequestUsage call itself.)
    saveRequestUsage: (...args) => {
      mocks.saveUsageCalls.push(args[0]);
      return actual.saveRequestUsage(...args);
    },
  };
});

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getAdapter } = await import("@/lib/db/driver.js");
const { readContextStatus, __setContextStatusDirForTest } =
  await import("../../open-sse/handlers/chatCore/contextStatusStore.js");

// Report usage for the body actually received: prompt = dispatched chars / 4.
function makeSizedExecutorRes(args) {
  const dispatchedChars = JSON.stringify(args?.body ?? {}).length;
  return {
    response: new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: Math.ceil(dispatchedChars / 4), completion_tokens: 50 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ),
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  };
}

function baseArgs(overrides = {}) {
  return {
    requestId: "c0ffee42",
    body: {
      model: "deepseek/deepseek-chat",
      stream: false,
      messages: [
        { role: "user", content: "x".repeat(2000) },
      ],
    },
    modelInfo: { provider: "deepseek", model: "deepseek-chat" },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "TAG", nextTag: () => "TAG", fmtThink: () => null },
    connectionId: "conn-1",
    sid: "0badf00d",
    rtkEnabled: true,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    clientRawRequest: { headers: {}, body: {} },
    ...overrides,
  };
}

async function readLedgerRow(rid) {
  const db = await getAdapter();
  for (let i = 0; i < 50; i++) {
    const row = db.get(`SELECT * FROM costLedger WHERE id = ?`, [rid]);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe("cost ledger pipeline", () => {
  let storeDir;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeMock.mockImplementation(async (args) => makeSizedExecutorRes(args));
    globalThis.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-ledger-ctx-"));
    __setContextStatusDirForTest(storeDir);
  });

  afterEach(() => {
    __setContextStatusDirForTest(null);
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it("savers off: baseline equals actual, savedUsd is zero", async () => {
    const res = await handleChatCore(baseArgs({ rtkEnabled: false }));
    expect(res.success).toBe(true);
    const row = await readLedgerRow("c0ffee42");
    expect(row).not.toBeNull();
    expect(row.model).toBe("deepseek-chat");
    expect(row.sid).toBe("0badf00d");
    expect(row.outputTokens).toBe(50);
    expect(row.baselineUsd).toBeCloseTo(row.actualUsd, 12);
    expect(row.savedUsd).toBe(0);
    expect(row.saverSavedUsd).toBe(0);
    expect(row.cacheSavedUsd).toBe(0);
  });

  it("savers on: baseline exceeds actual, savedUsd is positive and lands in the saver component", async () => {
    const res = await handleChatCore(baseArgs({ requestId: "c0ffee51", rtkEnabled: true }));
    expect(res.success).toBe(true);
    const row = await readLedgerRow("c0ffee51");
    expect(row).not.toBeNull();
    const db = await getAdapter();
    const usage = db.get('SELECT requestId,completionId FROM usageHistory WHERE completionId=?',[row.completionId]);
    expect(usage?.requestId).toBeTruthy();
    expect(usage?.completionId).toBe(row.completionId);
    // RTK shrank the 2000-char message to 100 before dispatch, so the provider
    // billed a small prompt while the baseline still costs the pre-saver body.
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.inputTokens).toBeLessThan(500);
    expect(row.baselineUsd).toBeGreaterThan(row.actualUsd);
    expect(row.savedUsd).toBeGreaterThan(0);
    // No cache tokens reported: the whole saving is saver work.
    expect(row.saverSavedUsd).toBeCloseTo(row.savedUsd, 12);
    expect(row.cacheSavedUsd).toBe(0);
  });

  it("estimated usage (provider omitted it) writes no ledger row", async () => {
    mocks.executeMock.mockImplementation(async () => ({
      response: new Response(
        JSON.stringify({
          id: "chatcmpl-x",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
          // no usage block at all -> the handler estimates and marks it
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
    const res = await handleChatCore(baseArgs({ requestId: "c0ffee52", rtkEnabled: false }));
    expect(res.success).toBe(true);
    const db = await getAdapter();
    await new Promise((r) => setTimeout(r, 200));
    expect(db.get(`SELECT * FROM costLedger WHERE id = ?`, ["c0ffee52"])).toBeUndefined();
  });

  it("the current request's saver dollars land on its own context-status entry (no one-request lag)", async () => {
    const res = await handleChatCore(baseArgs({ requestId: "c0ffee61", sid: "cafe9999", rtkEnabled: true }));
    expect(res.success).toBe(true);
    const row = await readLedgerRow("c0ffee61");
    expect(row).not.toBeNull();
    expect(row.saverSavedUsd).toBeGreaterThan(0);
    // The onReqSummary listener chains this request's own ledger write ahead
    // of the rollup read, so the entry's dollarsSaved already includes the
    // request that just completed — not only the previous ones.
    let entry = null;
    for (let i = 0; i < 50; i++) {
      entry = await readContextStatus("cafe9999");
      if (entry && typeof entry.dollarsSaved === "number") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(entry).not.toBeNull();
    expect(entry.dollarsSaved).toBeGreaterThan(0);
    expect(entry.dollarsSaved).toBeCloseTo(row.saverSavedUsd, 12);
  });

  it("streaming path: usage with cache fields lands one ledger row with the saver/cache split", async () => {
    const sse =
      'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
      'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":400}}}\n\n' +
      "data: [DONE]\n\n";
    mocks.executeMock.mockImplementation(async () => ({
      response: new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
    const res = await handleChatCore(baseArgs({
      requestId: "c0ffee71",
      sid: "cafe9998",
      rtkEnabled: false,
      body: {
        model: "openai/gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      modelInfo: { provider: "openai", model: "gpt-4o" },
    }));
    expect(res.success).toBe(true);
    await res.response.text(); // drain: onStreamComplete fires at flush
    const row = await readLedgerRow("c0ffee71");
    expect(row).not.toBeNull();
    expect(row.inputTokens).toBe(1000);
    expect(row.cacheReadTokens).toBe(400);
    expect(row.cacheWriteTokens).toBe(0);
    expect(row.outputTokens).toBe(200);
    // gpt-4o rates per 1M: input 2.5, cached 1.25, output 10.0.
    const actualUncachedUsd = (1000 * 2.5 + 200 * 10.0) / 1e6;
    const actualUsd = (600 * 2.5 + 400 * 1.25 + 200 * 10.0) / 1e6;
    expect(row.cacheSavedUsd).toBeCloseTo(actualUncachedUsd - actualUsd, 12);
    expect(row.saverSavedUsd).toBeCloseTo(row.baselineUsd - actualUncachedUsd, 12);
    expect(row.savedUsd).toBeCloseTo(row.saverSavedUsd + row.cacheSavedUsd, 12);
  });

  it("ledger failure never blocks usage persistence", async () => {
    mocks.ledgerFail.current = true;
    try {
      const res = await handleChatCore(baseArgs({ requestId: "c0ffee60", rtkEnabled: false }));
      expect(res.success).toBe(true);
      // Usage persistence ran: saveRequestUsage was invoked with the real
      // provider-reported tokens even though the ledger attempt rejected.
      expect(mocks.saveUsageCalls.length).toBeGreaterThan(0);
      const usage = mocks.saveUsageCalls.find((u) => u?.tokens?.prompt_tokens > 0);
      expect(usage).toBeTruthy();
      expect(usage.tokens.completion_tokens).toBe(50);
    } finally {
      mocks.ledgerFail.current = false;
    }
  });
});
