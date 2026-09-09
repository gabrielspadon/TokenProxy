import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// UP.* decision lines from the chat.js admission/retry loop (docs/logging-design.md
// wave 2). Drives handleChat with a mocked handleChatCore so each retry-loop
// branch fires deterministically, and reads the rendered decide() lines.

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const dispatchMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

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
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(() => "***"),
  warn: vi.fn(),
  error: vi.fn(),
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
    requireApiKey: false,
    providerThinking: {},
    cavemanEnabled: false,
    ponytailEnabled: false,
    ccFilterNaming: false,
    connectTimeoutMs: 15000,
    providerStrategies: { codex: { connectTimeoutMs: Infinity } },
  });
  modelMocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5.6-sol" });
  modelMocks.getComboModels.mockResolvedValue(null);
  authMocks.getProviderCredentials.mockImplementation(async (provider, exclude) =>
    exclude?.has?.("account-a") ? null : credentials("account-a")
  );
  authMocks.clearAccountError.mockResolvedValue(undefined);
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
});

afterEach(() => {
  consoleSpy.mockRestore();
});

const classLines = (cls) => lines.filter((l) => l.includes(` ${cls}.`));

let handleChat;
beforeAll(async () => {
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
});

function credentials(account) {
  return {
    apiKey: `sk-${account}`,
    connectionId: account,
    connectionName: account,
    providerSpecificData: {},
  };
}

function failure(status = 507, message = "buffer-overflow") {
  return {
    success: false,
    failureMetadata: { safeToReplay: true },
    status,
    response: new Response(JSON.stringify({ error: { message } }), { status }),
    error: status === 507
      ? "[507]: exceeded request buffer limit while retrying upstream"
      : new Error(message),
  };
}

function request(headers = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "codex/gpt-5.6-sol", messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("UP lines (chat.js admission/retry loop)", () => {
  it("names UP.replay-overflow when the same account fails again", async () => {
    dispatchMocks.handleChatCore.mockImplementation(async () => failure(507));
    const res = await handleChat(request({ "x-tp-rid": "aa11aa11" }));
    expect(res.status).toBe(507);
    const ups = classLines("UP");
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain("UP.replay-overflow");
    expect(ups[0]).toContain("rid=aa11aa11");
  });

  it("names UP.no-replay while a healthy account waits through a cooldown", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 500, mustWait: true });
    dispatchMocks.handleChatCore.mockImplementation(async () => failure(500, "server error"));
    const res = await handleChat(request({ "x-tp-rid": "bb22bb22" }));
    expect(res.status).toBe(500);
    const ups = classLines("UP");
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain("UP.no-replay");
    expect(ups[0]).toContain("why=account-cooldown");
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(res.headers.get("retry-after")).toBe("1");
    for (const l of ups) expect(l).toContain("rid=bb22bb22");
  });

  it("names UP.failover with the advertised lock after confirmed quota depletion", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 60000, mustWait: false });
    dispatchMocks.handleChatCore.mockImplementation(async () => failure(429, "quota exhausted"));
    const res = await handleChat(request({ "x-tp-rid": "cc33cc33" }));
    expect(res.status).toBe(429);
    const ups = classLines("UP");
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain("UP.failover");
    expect(ups[0]).toContain("from=account-");
    expect(ups[0]).toContain("to=pool");
    expect(ups[0]).toContain("why=locked-60s");
  });

  it("names UP.attempt-ceiling when x-max-attempts is exhausted", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 500 });
    dispatchMocks.handleChatCore.mockImplementation(async () => failure(500, "server error"));
    await handleChat(request({ "x-tp-rid": "dd44dd44", "x-max-attempts": "1" }));
    const ups = classLines("UP");
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain("UP.attempt-ceiling");
    expect(ups[0]).toContain("attempts=1");
  });

  it("names UP.no-replay when an accepted generation returns an empty stream", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 500 });
    dispatchMocks.handleChatCore.mockImplementation(async () => ({
      success: true,
      response: new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
    }));
    await handleChat(request({ "x-tp-rid": "ee55ee55" }));
    const ups = classLines("UP");
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain("UP.no-replay");
    expect(ups[0]).toContain("why=accepted-empty-generation");
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
  });
});

// Schema/folding tests capture admitted lines; bounded asynchronous transport has its own suite.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
