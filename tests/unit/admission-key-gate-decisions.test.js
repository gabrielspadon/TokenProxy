// ADM.key-required / ADM.key-invalid — the chat.js API-key gate
// (docs/logging-design.md row 5). One line per refusal naming which
// requirement fired (setting or env) and whether a key was presented, without
// ever naming the key itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  isValidApiKey: vi.fn(),
  markAccountUnavailable: vi.fn(),
  getReachableProviders: vi.fn(),
}));
const coreMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock("open-sse/index.js", () => ({}), { virtual: true });
vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: authMocks.clearAccountError,
  getProviderCredentials: authMocks.getProviderCredentials,
  isValidApiKey: authMocks.isValidApiKey,
  markAccountUnavailable: authMocks.markAccountUnavailable,
  getReachableProviders: authMocks.getReachableProviders,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: coreMocks.handleChatCore }));
vi.mock("@/lib/localDb", () => ({
  getSettings: settingsMocks.getSettings,
  validateApiKey: vi.fn(),
}));

// Isolate the output transport while keeping the decision logger real. Native
// asynchronous writes are covered by the bounded-output and runtime suites.
vi.mock("../../open-sse/utils/asyncLogOutput.js", () => ({
  logOutput: line => console.log(line),
  flushLogOutput: async () => {},
  logOutputStatus: () => ({}),
}));

import { __decide } from "@/shared/observability/decide.js";
import { refreshAdmissionPolicy } from "@/sse/services/resourceAdmission.js";
import { handleChat, __rateLimiter, __admissionQueue } from "@/sse/handlers/chat.js";

let lines = [];
let warnLines = [];
let logSpy;
let warnSpy;

beforeEach(() => {
  __decide.resetState();
  __decide.disableSink();
  __rateLimiter.reset();
  __admissionQueue.reset();
  lines = [];
  warnLines = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((l) => lines.push(l));
  warnSpy = vi.spyOn(console, "warn").mockImplementation((l) => warnLines.push(l));
  settingsMocks.getSettings.mockResolvedValue({ requireApiKey: true });
  authMocks.isValidApiKey.mockResolvedValue(false);
  coreMocks.handleChatCore.mockReset();
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  vi.unstubAllEnvs();
});

const chatRequest = (headers = {}) =>
  new Request("http://localhost:20128/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });

describe("chat.js API-key gate", () => {
  it("key-required: no key presented, setting fired -> source=setting presented=false, no AUTH warn", async () => {
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(401);
    const line = lines.find((l) => l.includes("ADM.key-required"));
    expect(line).toMatch(/rid=[0-9a-f]{8}/);
    expect(line).toContain("source=setting");
    expect(line).toContain("presented=false");
    expect(lines.filter((l) => l.includes("ADM.key-required"))).toHaveLength(1);
    expect(warnLines.join(" ")).not.toContain("AUTH");
    expect(coreMocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("key-required: env-only tightening -> source=env", async () => {
    settingsMocks.getSettings.mockResolvedValue({});
    vi.stubEnv("REQUIRE_API_KEY", "true");
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(401);
    const line = lines.find((l) => l.includes("ADM.key-required"));
    expect(line).toContain("source=env");
    expect(line).toContain("presented=false");
  });

  it("key-invalid: a presented key that fails validation -> presented=true, key never appears", async () => {
    const res = await handleChat(chatRequest({ authorization: "Bearer sk-bad-000" }));
    expect(res.status).toBe(401);
    const line = lines.find((l) => l.includes("ADM.key-invalid"));
    expect(line).toMatch(/rid=[0-9a-f]{8}/);
    expect(line).toContain("source=setting");
    expect(line).toContain("presented=true");
    expect(line).not.toContain("sk-bad-000");
    expect(warnLines.join(" ")).not.toContain("AUTH");
    expect(coreMocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("D-10: the key-gate refusal also emits REQ.refused with the same rid as the ADM line", async () => {
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(401);
    const admLine = lines.find((l) => l.includes("ADM.key-required"));
    const refused = lines.find((l) => l.includes("REQ.refused"));
    expect(refused).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]{8}Z REQ\.refused rid=[0-9a-f]{8} why=key-required$/);
    expect(refused).toContain(admLine.match(/rid=[0-9a-f]{8}/)[0]);
  });

  it("D-10: a presented-but-invalid key gets REQ.refused why=key-invalid", async () => {
    const res = await handleChat(chatRequest({ authorization: "Bearer sk-bad-000" }));
    expect(res.status).toBe(401);
    const refused = lines.find((l) => l.includes("REQ.refused"));
    expect(refused).toMatch(/REQ\.refused rid=[0-9a-f]{8} why=key-invalid$/);
  });

  // The 429 storm: 7,745 of 17,422 production requests refused on ONE key at
  // 60/60s, five real upstream 429s in the same window. An authenticated caller
  // is no longer counted by that window at all -- it takes a concurrency slot,
  // and only queue overflow can refuse it.
  it("an authenticated caller takes a concurrency slot, not a window hit", async () => {
    authMocks.isValidApiKey.mockResolvedValue(true);
    const key = "sk-parallel-agents";
    // Burn the window on this exact key. The old gate answered 429 from here on.
    let limited = false;
    for (let n = 0; n < 10000 && !limited; n++) limited = __rateLimiter.isRateLimited(key);
    expect(limited).toBe(true);

    // Park the request inside the handler, downstream of admission, so the slot
    // it holds is observable rather than already released.
    await refreshAdmissionPolicy();
    let releaseSettings;
    settingsMocks.getSettings.mockReturnValue(new Promise(resolve => { releaseSettings = resolve; }));
    const pending = handleChat(chatRequest({ authorization: `Bearer ${key}` }), null, { body: { messages: [] } });
    await vi.waitFor(() => expect(__admissionQueue.stateOf(key)).toEqual({ active: 1, queued: 0 }));

    expect(lines.filter((l) => l.includes("ADM.ratelimited"))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("REQ.refused"))).toHaveLength(0);
    expect(pending).toBeInstanceOf(Promise);
    releaseSettings({ requireApiKey: true });
    const response = await pending;
    await response.body?.cancel();
  });
});
