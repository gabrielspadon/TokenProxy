import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trackResponseLifetime } from '../helpers/response-lifetime.js';
import { isSafeQuotaAccountRejection } from 'open-sse/utils/replaySafety.js';

// A quota-class 429 carries an upstream x-should-retry: false, which
// isReplaySafeRejection turns into safeToReplay: false. That advice is about
// retrying the SAME account and must not stop the loop from trying another
// key: an upstream 429 generated nothing, so no account can be double-billed.
// Observed 2026-09-08 holding a 14-connection pool to one account per request
// while claude-fable-5-1 had no credits on the pinned one.

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const dispatchMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: authMocks.clearAccountError,
  extractApiKey: () => null,
  getProviderCredentials: authMocks.getProviderCredentials,
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: authMocks.markAccountUnavailable,
}));
vi.mock("open-sse/handlers/chatCore.js", () => dispatchMocks);
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  detectRequiredCapabilities: vi.fn(() => []),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));
vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getModelInfo: (...a) => modelMocks.getModelInfo(...a),
  getComboModels: (...a) => modelMocks.getComboModels(...a),
}));
vi.mock("@/lib/localDb", () => settingsMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, account) => account),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), maskKey: vi.fn(() => "***"), warn: vi.fn(), error: vi.fn(),
}));

import { __decide } from "@/shared/observability/decide.js";

let lines;
let consoleSpy;

beforeEach(() => {
  __decide.resetState();
  __decide.disableSink();
  lines = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((l) => {
    if (typeof l === "string") lines.push(l);
  });
  vi.clearAllMocks();
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: false, providerThinking: {}, cavemanEnabled: false, ponytailEnabled: false,
    ccFilterNaming: false, connectTimeoutMs: 15000,
    providerStrategies: { codex: { connectTimeoutMs: Infinity } },
  });
  modelMocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5.6-sol" });
  modelMocks.getComboModels.mockResolvedValue(null);
  // Three accounts, handed out in order and never repeated.
  authMocks.getProviderCredentials.mockImplementation(async (_provider, exclude) => {
    const next = ["account-a", "account-b", "account-c"].find((a) => !exclude?.has?.(a));
    return next ? account(next) : null;
  });
  authMocks.clearAccountError.mockResolvedValue(undefined);
});

afterEach(() => consoleSpy.mockRestore());

const classLines = (cls) => lines.filter((l) => l.includes(` ${cls}.`));

let rawHandleChat;
const handleChat = trackResponseLifetime((...args) => rawHandleChat(...args));
beforeAll(async () => {
  ({ handleChat: rawHandleChat } = await import("../../src/sse/handlers/chat.js"));
});

function account(name) {
  return { apiKey: `sk-${name}`, connectionId: name, connectionName: name, providerSpecificData: {} };
}

// What the wire actually produced: a 429 the upstream marked non-retryable.
function creditRefusal() {
  return {
    success: false,
    failureMetadata: { safeToReplay: false, safeAcrossAccounts: true },
    status: 429,
    response: new Response(JSON.stringify({ error: { message: "Usage credits are required for this model." } }),
      { status: 429, headers: { "x-should-retry": "false" } }),
    error: "[429]: Usage credits are required for this model.",
  };
}

function request(headers = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "codex/gpt-5.6-sol", messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("quota 429 with upstream x-should-retry: false", () => {
  it('does not rotate a physical account when the canonical 429 message reports accepted generation', async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 5000, mustWait: false, failureClass: 'quota' });
    dispatchMocks.handleChatCore.mockImplementation(async () => {
      const payload = { error: { message: 'Request was accepted; generation billed before quota failure' } };
      const response = Response.json(payload, { status: 429, headers: { 'x-should-retry': 'false' } });
      return { success: false, status: 429, response, error: payload.error.message,
        failureMetadata: { safeToReplay: false, safeAcrossAccounts: isSafeQuotaAccountRejection(response, payload) } };
    });
    expect((await handleChat(request())).status).toBe(429);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledOnce();
    expect(authMocks.getProviderCredentials).toHaveBeenCalledOnce();
  });

  it.each([false, undefined])('requires positive wire evidence even when a synthetic 429 is classified as quota (%s)', async proof => {
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 5000, mustWait: false, failureClass: 'quota' });
    dispatchMocks.handleChatCore.mockImplementation(async () => {
      const result = creditRefusal();
      result.failureMetadata.safeAcrossAccounts = proof;
      result.response.headers.set('x-tokenproxy-replay-safe', 'false');
      return result;
    });
    expect((await handleChat(request())).status).toBe(429);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
  });
  it("rotates to other accounts instead of stopping at the first", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true, cooldownMs: 120000, mustWait: false, failureClass: "quota",
    });
    dispatchMocks.handleChatCore.mockImplementation(async () => creditRefusal());

    const res = await handleChat(request({ "x-tp-rid": "dd44dd44" }));

    expect(res.status).toBe(429);
    expect(dispatchMocks.handleChatCore.mock.calls.length).toBeGreaterThan(1);
    expect(classLines("UP").filter((l) => l.includes("why=generation-outcome-uncertain"))).toHaveLength(0);
  });

  it("still refuses to replay when the outcome is genuinely uncertain", async () => {
    // 'transient' is not the quota class, so the wire permission still governs.
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true, cooldownMs: 5000, mustWait: false, failureClass: "transient",
    });
    dispatchMocks.handleChatCore.mockImplementation(async () => ({
      success: false,
      failureMetadata: { safeToReplay: false },
      status: 502,
      response: new Response("{}", { status: 502 }),
      error: new Error("bad gateway"),
    }));

    const res = await handleChat(request({ "x-tp-rid": "ee55ee55" }));

    expect(res.status).toBe(502);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
    const ups = classLines("UP");
    expect(ups.some((l) => l.includes("UP.no-replay") && l.includes("why=generation-outcome-uncertain"))).toBe(true);
  });

  it("does not widen a quota failure on a status other than 429", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true, cooldownMs: 5000, mustWait: false, failureClass: "quota",
    });
    dispatchMocks.handleChatCore.mockImplementation(async () => ({
      success: false,
      failureMetadata: { safeToReplay: false },
      status: 402,
      response: new Response("{}", { status: 402 }),
      error: new Error("payment required"),
    }));

    const res = await handleChat(request({ "x-tp-rid": "ff66ff66" }));

    expect(res.status).toBe(402);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
  });
});
