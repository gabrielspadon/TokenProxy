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

function failure() {
  const error = "[507]: exceeded request buffer limit while retrying upstream";
  return {
    success: false,
    status: 507,
    failureMetadata: { safeToReplay: true },
    error,
    response: Response.json({ error: { message: error } }, { status: 507 }),
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
  vi.clearAllMocks();
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

describe("chat request replay", () => {
  it("does not replay a buffer error without proof the generation was rejected", async () => {
    dispatchMocks.handleChatCore.mockImplementation(() => ({ ...failure(), failureMetadata: null }));

    const response = await handleChat(request());

    expect(response.status).toBe(507);
    expect(response.headers.get("x-tokenproxy-replay-safe")).toBe("false");
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("passes unresolved provider and global timeouts to chat core", async () => {
    dispatchMocks.handleChatCore.mockImplementation(() => success());

    const response = await handleChat(request());

    expect(response.status).toBe(200);
    expect(dispatchMocks.handleChatCore.mock.calls[0][0].connectTimeout).toMatchObject({
      providerOverride: 8000,
      globalTimeout: 15000,
    });
  });

  it.each([
    [true, true],
    [false, false],
    ["true", false],
    [1, false],
  ])("passes only an exact persisted Fast boolean %#", async (fastMode, expected) => {
    settingsMocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      providerThinking: {},
      providerStrategies: { codex: { fastMode } },
    });
    dispatchMocks.handleChatCore.mockImplementation(() => success());

    const response = await handleChat(request());

    expect(response.status).toBe(200);
    expect(dispatchMocks.handleChatCore.mock.calls[0][0].codexFastMode).toBe(expected);
  });

  it("passes invalid imported timeout values through without coercion", async () => {
    settingsMocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      providerThinking: {},
      cavemanEnabled: false,
      ponytailEnabled: false,
      ccFilterNaming: false,
      connectTimeoutMs: "15000",
      providerStrategies: { codex: { connectTimeoutMs: Infinity } },
    });
    dispatchMocks.handleChatCore.mockImplementation(() => success());

    const response = await handleChat(request());

    expect(response.status).toBe(200);
    expect(dispatchMocks.handleChatCore.mock.calls[0][0].connectTimeout).toMatchObject({
      providerOverride: Infinity,
      globalTimeout: "15000",
    });
  });

  it("replays once on the same account before returning success", async () => {
    let attempts = 0;
    dispatchMocks.handleChatCore.mockImplementation(() => {
      attempts += 1;
      return attempts === 1 ? failure() : success();
    });

    const response = await handleChat(request());

    expect(response.status).toBe(200);
    // The options object also carries this request's client session evidence
    // (clientHeaders/clientBody), which is what selection hashes into the
    // durable pin. Match on the ROUTING directives this test is about, then
    // assert the other two are absent, so the exactness that mattered here --
    // no stray pin or lock bypass leaking in -- survives the wider shape.
    expect(authMocks.getProviderCredentials).toHaveBeenNthCalledWith(
      2,
      "codex",
      expect.any(Set),
      "gpt-5.6-sol",
      expect.objectContaining({ preferredConnectionId: "account-a" }),
    );
    const replayOptions = authMocks.getProviderCredentials.mock.calls[1][3];
    expect(replayOptions.strictPreferredConnection).toBeUndefined();
    expect(replayOptions.ignoreModelLockConnId).toBeUndefined();
    expect(dispatchMocks.handleChatCore.mock.calls.map(([options]) => options.connectionId))
      .toEqual(["account-a", "account-a"]);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("returns a repeated overflow without looping", async () => {
    dispatchMocks.handleChatCore.mockImplementation(() => failure());

    const response = await handleChat(request());

    expect(response.status).toBe(507);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledTimes(1);
  });
});
