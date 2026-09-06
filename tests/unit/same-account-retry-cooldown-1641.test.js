import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const dispatchMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(() => "***"),
  warn: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: authMocks.clearAccountError,
  extractApiKey: () => null,
  getProviderCredentials: authMocks.getProviderCredentials,
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: authMocks.markAccountUnavailable,
}));
vi.mock("open-sse/handlers/chatCore.js", () => dispatchMocks);
// Spread the real module: the chat handler imports more from it than these
// three, and a mock that returns only some fails the whole file with
// "No <name> export" rather than one assertion.
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  detectRequiredCapabilities: vi.fn(() => []),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));
// Spread the real module: a partial mock fails the WHOLE file the moment the
// module gains an export this object does not name (#577 added isModelDisabled).
vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...modelMocks,
}));
vi.mock("@/lib/localDb", () => settingsMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => logMocks);

let handleChat;

function credentials(connectionId) {
  return {
    connectionId,
    connectionName: connectionId,
    apiKey: "provider-key",
    providerSpecificData: {},
  };
}

function failure(status = 429, safeToReplay = true) {
  const error = "provider rejected request";
  return {
    success: false,
    status,
    failureMetadata: { safeToReplay },
    error,
    response: Response.json({ error: { message: error } }, { status }),
  };
}

function success() {
  return {
    success: true,
    response: Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
  };
}

function request() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "codex/gpt-5.6-sol",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

beforeAll(async () => {
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
});

beforeEach(() => {
  vi.resetAllMocks();
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: false,
    providerThinking: {},
    cavemanEnabled: false,
    ponytailEnabled: false,
    ccFilterNaming: false,
    connectTimeoutMs: 15000,
    providerStrategies: { codex: { connectTimeoutMs: 8000 } },
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5.6-sol" });
  authMocks.getProviderCredentials.mockResolvedValue(credentials("account-a"));
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
});

describe("same-account retry permission and cooldown (#1641)", () => {
  it.each([500, 5000, 120000])("does not immediately retry or rotate a healthy pin during a %i ms wait", async (cooldownMs) => {
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true, mustWait: true, retrySameAccount: false, cooldownMs,
    });
    dispatchMocks.handleChatCore.mockImplementation(() => failure());
    const response = await handleChat(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(Math.ceil(cooldownMs / 1000)));
    expect(response.headers.get("x-tokenproxy-replay-safe")).toBe("false");
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("retries the same account only with explicit permission, no generation, and zero cooldown", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true, mustWait: false, retrySameAccount: true, cooldownMs: 0,
    });
    dispatchMocks.handleChatCore.mockImplementationOnce(() => failure(503)).mockImplementation(() => success());
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(dispatchMocks.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["account-a", "account-a"]);
  });

  it("does not replay uncertain generation despite an explicit same-account retry hint", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true, mustWait: false, retrySameAccount: true, cooldownMs: 0,
    });
    dispatchMocks.handleChatCore.mockImplementation(() => failure(503, false));
    const response = await handleChat(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-tokenproxy-replay-safe")).toBe("false");
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("rotates after verified depletion without retrying a credential before its reset", async () => {
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true, mustWait: false, retrySameAccount: false, cooldownMs: 3600000,
    });
    authMocks.getProviderCredentials.mockImplementation(async (_provider, exclude) =>
      credentials(exclude?.has("account-a") ? "account-b" : "account-a")
    );
    dispatchMocks.handleChatCore.mockImplementationOnce(() => failure()).mockImplementation(() => success());
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(dispatchMocks.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["account-a", "account-b"]);
  });
});
