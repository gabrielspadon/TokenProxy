import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  CASCADE_ROUTE_KINDS,
  __cascadeSessionPins,
  classifyExploration,
  isRetryableCascadeStatus,
  isSessionEscalated,
  normalizeCascadePairs,
  normalizeModelRef,
  pinEscalatedSession,
  planCascade,
} from "@/lib/stepRouter";

// The wiring under test lives in src/sse/handlers/chat.js. The handler is
// driven for real below with the dispatch boundary (handleChatCore) mocked —
// the same harness as chat-handler-dispatch-branches.test.js — so escalation,
// tagging, session stickiness and body non-mutation are asserted from
// behavior, not only from source. No network: the executor boundary is the
// mock.

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  getReachableProviders: vi.fn(),
}));
const coreMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  isModelDisabled: vi.fn(),
}));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const comboMocks = vi.hoisted(() => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()),
  resolveComboMemberConnection: vi.fn(() => null),
  resolveComboTokenSaver: vi.fn(() => ({})),
}));
const capacityMocks = vi.hoisted(() => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
}));
const agentRoleMocks = vi.hoisted(() => ({
  detectAgentRole: vi.fn(() => null),
  applyAgentRoleGroup: vi.fn((models) => models),
}));
const bypassMocks = vi.hoisted(() => ({ handleBypassRequest: vi.fn(() => null) }));
const autoMocks = vi.hoisted(() => ({
  AUTO_MODEL_IDS: new Set(["auto"]),
  resolveAutoModel: vi.fn(),
}));
const accessMocks = vi.hoisted(() => ({ refuseDisallowedModel: vi.fn(async () => null) }));
const compatMocks = vi.hoisted(() => ({
  stripContextSuffix: vi.fn((s) => s),
  looksLikeClaudeWrappedModel: vi.fn(() => false),
  normalizeClaudeModelName: vi.fn((s) => s),
  buildClaudeRoutingIndex: vi.fn(async () => ({})),
  readClaudeCompat: vi.fn(() => ({ enabled: false })),
}));
const projectIdMocks = vi.hoisted(() => ({ getProjectIdForConnection: vi.fn(async () => null) }));
const refreshMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(async (_p, c) => ({ ...c })),
  updateProviderCredentials: vi.fn(async () => {}),
}));
const usageMocks = vi.hoisted(() => ({ getActiveRequests: vi.fn(async () => []) }));
const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "***"),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  ...authMocks,
  isValidApiKey: vi.fn(async () => false),
}));
vi.mock("open-sse/handlers/chatCore.js", () => coreMocks);
vi.mock("@/sse/services/model.js", () => modelMocks);
vi.mock("@/lib/localDb", () => settingsMocks);
vi.mock("open-sse/services/combo.js", () => comboMocks);
vi.mock("open-sse/services/capacityAdapter.js", () => capacityMocks);
vi.mock("open-sse/utils/agentRole.js", () => agentRoleMocks);
vi.mock("open-sse/utils/bypassHandler.js", () => bypassMocks);
vi.mock("@/sse/services/autoRouter.js", () => autoMocks);
vi.mock("@/sse/services/modelAccess.js", () => accessMocks);
vi.mock("@/lib/claudeCompat", () => compatMocks);
vi.mock("open-sse/services/projectId.js", () => projectIdMocks);
vi.mock("@/lib/antigravityVerification", () => ({
  createAntigravityVerificationHooks: vi.fn(() => ({})),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => refreshMocks);
vi.mock("@/lib/usageDb.js", () => usageMocks);
vi.mock("@/sse/utils/logger.js", () => logMocks);
vi.mock("@/sse/services/accountLeaseRegistry.js", () => ({
  releaseAccountLease: vi.fn(),
  releaseAccountLeaseOnResponse: vi.fn((r) => r),
}));

const { handleChat, __rateLimiter } = await import("@/sse/handlers/chat.js");

const PAIRS = [{ strong: "anthropic/claude-sonnet-4-6", cheap: "anthropic/claude-haiku-4-5" }];
const STRONG = "anthropic/claude-sonnet-4-6";
const CHEAP = "anthropic/claude-haiku-4-5";

function explorationBody(overrides = {}) {
  return {
    model: STRONG,
    messages: [
      { role: "user", content: "What does this repo do?" },
      { role: "assistant", content: "It is a gateway." },
    ],
    ...overrides,
  };
}

// Pad the serialized body past the 64K-token (256K-char) ceiling.
function bigBody() {
  return explorationBody({ messages: [{ role: "user", content: "x".repeat(300_000) }] });
}

describe("classifyExploration", () => {
  it("classifies a plain Q&A body as exploration", () => {
    expect(classifyExploration(explorationBody())).toBe(true);
  });

  it("is false when a tool_result with is_error is in the last 3 turns (Claude shape)", () => {
    const body = explorationBody({
      messages: [
        { role: "user", content: "run the tests" },
        { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
        { role: "user", content: [{ type: "tool_result", is_error: true, content: "failing" }] },
        { role: "assistant", content: "Tests failed." },
        { role: "user", content: "why?" },
      ],
    });
    expect(classifyExploration(body)).toBe(false);
  });

  it("is false when an OpenAI tool message carries is_error", () => {
    const body = explorationBody({
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "Read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "1", content: "boom", is_error: true },
        { role: "user", content: "fix it" },
      ],
    });
    expect(classifyExploration(body)).toBe(false);
  });

  it("ignores a tool_error older than the last 3 turns", () => {
    const body = explorationBody({
      messages: [
        { role: "tool", tool_call_id: "0", content: "old failure", is_error: true },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: "e" },
      ],
    });
    expect(classifyExploration(body)).toBe(true); // error is turn 1 of 6, outside the last-3 slice
    const recent = explorationBody({
      messages: [
        { role: "tool", tool_call_id: "0", content: "recent failure", is_error: true },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    });
    expect(classifyExploration(recent)).toBe(false); // error IS in the last 3
  });

  it("is false when the last assistant turn made an Edit tool call (OpenAI shape)", () => {
    const body = explorationBody({
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "Edit", arguments: '{"file":"a.js"}' } }], content: null },
        { role: "user", content: "now what?" },
      ],
    });
    expect(classifyExploration(body)).toBe(false);
  });

  it("is false when the last assistant turn made a Write or str_replace call (Claude shape)", () => {
    for (const name of ["Write", "str_replace"]) {
      const body = explorationBody({
        messages: [
          { role: "assistant", content: [{ type: "tool_use", name, input: { file: "a.js" } }] },
          { role: "user", content: "next" },
        ],
      });
      expect(classifyExploration(body), name).toBe(false);
    }
  });

  it("is false when the last assistant turn ran Bash with a heredoc, true without one", () => {
    const heredoc = explorationBody({
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "Bash", arguments: '{"command":"cat <<EOF > f.txt"}' } }], content: null },
        { role: "user", content: "next" },
      ],
    });
    expect(classifyExploration(heredoc)).toBe(false);
    const plain = explorationBody({
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "Bash", arguments: '{"command":"ls -la"}' } }], content: null },
        { role: "user", content: "next" },
      ],
    });
    expect(classifyExploration(plain)).toBe(true);
  });

  it("reads the Bash command from a Claude tool_use input object", () => {
    const heredoc = explorationBody({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "cat <<EOF > f.txt" } }] },
        { role: "user", content: "next" },
      ],
    });
    expect(classifyExploration(heredoc)).toBe(false);
    const plain = explorationBody({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
        { role: "user", content: "next" },
      ],
    });
    expect(classifyExploration(plain)).toBe(true);
  });

  it("ignores edit/write calls in an assistant turn that is not the last", () => {
    const body = explorationBody({
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "Write", arguments: "{}" } }], content: null },
        { role: "user", content: "done, now explain the file" },
        { role: "assistant", content: "It writes rows to the DB." },
        { role: "user", content: "thanks" },
      ],
    });
    expect(classifyExploration(body)).toBe(true);
  });

  it("is false at or above the 64K-token prompt ceiling", () => {
    expect(classifyExploration(bigBody())).toBe(false);
  });

  it("skips system messages when counting turns", () => {
    const body = explorationBody({
      messages: [
        { role: "system", content: "You are a tool." },
        { role: "tool", tool_call_id: "0", content: "fail", is_error: true },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
      ],
    });
    // 5 non-system turns: the error is outside the last-3 slice even though a
    // system message padded the array to 6 entries.
    expect(classifyExploration(body)).toBe(true);
  });
});

describe("normalizeCascadePairs / normalizeModelRef", () => {
  it("accepts provider/model and provider:model spellings", () => {
    expect(normalizeModelRef("anthropic:claude-sonnet-4-6")).toBe(STRONG);
    expect(normalizeModelRef("anthropic/claude-sonnet-4-6")).toBe(STRONG);
    expect(normalizeModelRef("  anthropic/claude-sonnet-4-6 ")).toBe(STRONG);
    expect(normalizeModelRef("noseparator")).toBe("noseparator");
    expect(normalizeModelRef(42)).toBeNull();
    expect(normalizeModelRef("")).toBeNull();
  });

  it("drops malformed entries and keeps valid ones", () => {
    const pairs = normalizeCascadePairs([
      ...PAIRS,
      { strong: "x", cheap: "x" },
      { strong: "", cheap: "a/b" },
      { cheap: "a/b" },
      "garbage",
      null,
      { strong: "p/m", cheap: 7 },
    ]);
    expect(pairs.size).toBe(1);
    expect(pairs.get(STRONG)).toBe(CHEAP);
    expect(pairs.get("p/m")).toBeUndefined();
  });

  it("returns an empty map for non-array config", () => {
    for (const raw of [undefined, null, {}, "x", 3]) {
      expect(normalizeCascadePairs(raw).size).toBe(0);
    }
  });
});

describe("isRetryableCascadeStatus", () => {
  it("treats 408/429/5xx as retryable", () => {
    for (const s of [408, 429, 500, 502, 503, 504, 599]) {
      expect(isRetryableCascadeStatus(s), String(s)).toBe(true);
    }
  });
  it("treats 4xx (except 408/429) and 499 as non-retryable", () => {
    for (const s of [400, 401, 403, 404, 422, 499, 300]) {
      expect(isRetryableCascadeStatus(s), String(s)).toBe(false);
    }
  });
});

describe("planCascade", () => {
  beforeEach(() => __cascadeSessionPins.clear());

  it("is inert without config", () => {
    for (const pairs of [undefined, null, [], "garbage"]) {
      expect(planCascade({ body: explorationBody(), modelStr: STRONG, cascadePairs: pairs }).action).toBe("none");
    }
  });

  it("is inert when the request model is not a configured strong model", () => {
    const plan = planCascade({ body: explorationBody(), modelStr: "openai/gpt-5", cascadePairs: PAIRS });
    expect(plan.action).toBe("none");
  });

  it("is inert for a strong-class body (edit/write in last assistant turn)", () => {
    const body = explorationBody({
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "Edit", arguments: "{}" } }], content: null },
        { role: "user", content: "next" },
      ],
    });
    expect(planCascade({ body, modelStr: STRONG, cascadePairs: PAIRS }).action).toBe("none");
  });

  it("routes exploration-class steps to the cheap model with the cascade-cheap tag", () => {
    const plan = planCascade({ body: explorationBody(), modelStr: STRONG, cascadePairs: PAIRS, sid: "s1" });
    expect(plan).toMatchObject({ action: "cheap", cheapModel: CHEAP, strongModel: STRONG, tag: "cascade-cheap", sid: "s1" });
    expect(CASCADE_ROUTE_KINDS.cheap).toBe("cascade-cheap");
    expect(CASCADE_ROUTE_KINDS.strong).toBe("cascade-strong");
  });

  it("matches a colon-spelled config entry against a slash-spelled request model", () => {
    const plan = planCascade({ body: explorationBody(), modelStr: STRONG, cascadePairs: [{ strong: "anthropic:claude-sonnet-4-6", cheap: "anthropic:claude-haiku-4-5" }] });
    expect(plan.action).toBe("cheap");
  });

  it("sends a pinned session straight to strong with the cascade-strong tag", () => {
    pinEscalatedSession("s1", 1000);
    const plan = planCascade({ body: explorationBody(), modelStr: STRONG, cascadePairs: PAIRS, sid: "s1", now: 1000 });
    expect(plan).toMatchObject({ action: "strong", strongModel: STRONG, tag: "cascade-strong" });
  });

  it("does not pin sessions for models outside the cascade config", () => {
    pinEscalatedSession("s1", 1000);
    const plan = planCascade({ body: explorationBody(), modelStr: "openai/gpt-5", cascadePairs: PAIRS, sid: "s1", now: 1000 });
    expect(plan.action).toBe("none");
  });

  it("forgets the pin after the 30-minute TTL", () => {
    pinEscalatedSession("s1", 1000);
    expect(isSessionEscalated("s1", 1000 + 29 * 60 * 1000)).toBe(true);
    const fresh = planCascade({ body: explorationBody(), modelStr: STRONG, cascadePairs: PAIRS, sid: "s1", now: 1000 + 31 * 60 * 1000 });
    expect(fresh.action).toBe("cheap");
  });

  it("handles a null sid without pinning state", () => {
    const plan = planCascade({ body: explorationBody(), modelStr: STRONG, cascadePairs: PAIRS, sid: null });
    expect(plan.action).toBe("cheap");
    expect(__cascadeSessionPins.size()).toBe(0);
  });
});

describe("chat.js cascade wiring", () => {
  const chat = readFileSync(new URL("../../src/sse/handlers/chat.js", import.meta.url), "utf8");
  const core = readFileSync(new URL("../../open-sse/handlers/chatCore.js", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../../src/lib/db/repos/settingsRepo.js", import.meta.url), "utf8");

  it("defaults cascadePairs to an empty array so the feature ships inert", () => {
    expect(settings).toContain("cascadePairs: []");
  });

  it("plans only solo requests and dispatches through a cascade-aware wrapper", () => {
    expect(chat).toContain("async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, comboChain = null, callerSignal = request?.signal, cascadeCtx = null, allowCascade = false)");
    expect(chat).toContain("async function dispatchSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, comboChain = null, callerSignal = request?.signal, routeKindTag = null)");
    expect(chat).toContain("if (!cascadeCtx && allowCascade && !comboChain)");
    // The outer solo path is the only call site allowed to plan.
    expect(chat).toContain("return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, null, callerSignal, null, true);");
  });

  it("tags usage rows via routeKindOverride so both attempts record their kind", () => {
    expect(chat).toContain("routeKindOverride: routeKindTag,");
    expect(core).toContain('routeKind: routeKindOverride || (passthrough ? "passthrough"');
  });

  it("escalates retryable cheap failures to the strong model and pins the session", () => {
    expect(chat).toContain('cascadeCtx.tag === "cascade-cheap" && isRetryableCascadeStatus(response?.status)');
    expect(chat).toContain("pinEscalatedSession(cascadeCtx.sid);");
    expect(chat).toContain('{ tag: "cascade-strong", sid: cascadeCtx.sid, strong: cascadeCtx.strong }');
  });

  it("re-dispatches the SAME body object, never a mutated copy", () => {
    expect(chat).toContain("return handleSingleModelChat(body, cascadeCtx.strong, clientRawRequest, request, apiKey, comboChain, callerSignal,");
    expect(chat).not.toContain("structuredClone(body), model: cascadeCtx");
  });

  it("resolves the session id from client headers/body before account selection", () => {
    expect(chat).toContain("sid = resolveSessionId({ headers: clientRawRequest?.headers || null, body });");
  });
});

// Behavioral coverage of the cascade flow through the real handleChat, with
// the executor boundary (handleChatCore) mocked. The mock records one entry
// per dispatch — { model, routeKind, attempt, logicalRequestId } — which is
// exactly what the usage rows carry: chatCore persists routeKindOverride into
// requestStats.routeKind, and the shared requestIdentity (memoised per
// Request) hands each attempt the same logicalRequestId and the next attempt
// number via createContextTelemetry.
describe("cascade flow through handleChat (executor mocked)", () => {
  const dispatches = [];

  function chatRequest(body, headers = {}) {
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  function sseOk() {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  // One scripted executor outcome per dispatch, in order.
  function scriptExecutor(outcomes) {
    coreMocks.handleChatCore.mockImplementation(async (opts) => {
      const outcome = outcomes[dispatches.length];
      dispatches.push({
        model: opts.modelInfo.model,
        routeKind: opts.routeKindOverride,
        attempt: opts.contextTelemetry.nextAttempt(),
        logicalRequestId: opts.contextTelemetry.logicalRequestId,
        bodyModel: opts.body.model,
      });
      if (outcome.ok) return { success: true, response: sseOk() };
      return {
        success: false,
        status: outcome.status,
        error: `upstream ${outcome.status}`,
        response: new Response(`upstream ${outcome.status}`, { status: outcome.status }),
        failureMetadata: {},
      };
    });
  }

  const armedSettings = () => ({ cascadePairs: PAIRS });
  const explorationRequest = (sessionId = "sess-1") => ({
    model: STRONG,
    session_id: sessionId,
    messages: [
      { role: "user", content: "What does this repo do?" },
      { role: "assistant", content: "It is a gateway." },
      { role: "user", content: "where is the entrypoint?" },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dispatches.length = 0;
    __rateLimiter.reset();
    __cascadeSessionPins.clear();
    settingsMocks.getSettings.mockImplementation(async () => armedSettings());
    modelMocks.getModelInfo.mockImplementation(async (m) => {
      const [provider, ...rest] = String(m).split("/");
      return rest.length ? { provider, model: rest.join("/") } : { provider: null };
    });
    modelMocks.getComboModels.mockResolvedValue(null);
    modelMocks.isModelDisabled.mockResolvedValue(false);
    authMocks.getReachableProviders.mockResolvedValue(new Set());
    authMocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-cascade-1",
      connectionName: "cascade-test",
      providerSpecificData: {},
      accountLease: null,
    });
    // The failed attempt returns its upstream response to the caller (here:
    // the cascade wrapper) instead of rotating, so the wrapper sees the real
    // status.
    authMocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: false, cooldownMs: 0, mustWait: false, retrySameAccount: false,
    });
  });

  it("is inert without config: one dispatch, original model, no tag", async () => {
    settingsMocks.getSettings.mockResolvedValue({});
    scriptExecutor([{ ok: true }]);
    const res = await handleChat(chatRequest(explorationRequest()));
    expect(res.status).toBe(200);
    expect(dispatches).toEqual([
      expect.objectContaining({ model: "claude-sonnet-4-6", routeKind: null, attempt: 1 }),
    ]);
  });

  it("routes an exploration-class step to the cheap model tagged cascade-cheap", async () => {
    scriptExecutor([{ ok: true }]);
    const res = await handleChat(chatRequest(explorationRequest()));
    expect(res.status).toBe(200);
    expect(dispatches).toEqual([
      expect.objectContaining({
        model: "claude-haiku-4-5",
        routeKind: CASCADE_ROUTE_KINDS.cheap,
        attempt: 1,
        bodyModel: CHEAP,
      }),
    ]);
  });

  it("leaves a strong-class step on the strong model untagged", async () => {
    scriptExecutor([{ ok: true }]);
    const body = explorationRequest();
    body.messages = [
      { role: "assistant", tool_calls: [{ function: { name: "Edit", arguments: "{}" } }], content: null },
      { role: "user", content: "next" },
    ];
    const res = await handleChat(chatRequest(body));
    expect(res.status).toBe(200);
    expect(dispatches).toEqual([
      expect.objectContaining({ model: "claude-sonnet-4-6", routeKind: null }),
    ]);
  });

  it.each([429, 500, 503])(
    "escalates a retryable cheap failure (%i) to the strong model and records both attempts",
    async (status) => {
      scriptExecutor([{ status }, { ok: true }]);
      const res = await handleChat(chatRequest(explorationRequest()));
      expect(res.status).toBe(200); // the client sees one final response
      expect(dispatches).toEqual([
        expect.objectContaining({ model: "claude-haiku-4-5", routeKind: CASCADE_ROUTE_KINDS.cheap, attempt: 1 }),
        expect.objectContaining({ model: "claude-sonnet-4-6", routeKind: CASCADE_ROUTE_KINDS.strong, attempt: 2 }),
      ]);
      // One logical request, two distinct attempts.
      expect(dispatches[1].logicalRequestId).toBe(dispatches[0].logicalRequestId);
      expect(isSessionEscalated("sess-1")).toBe(true);
    },
  );

  it("does not escalate a 400: the cheap error is the answer", async () => {
    scriptExecutor([{ status: 400 }]);
    const res = await handleChat(chatRequest(explorationRequest()));
    expect(res.status).toBe(400);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].routeKind).toBe(CASCADE_ROUTE_KINDS.cheap);
    expect(isSessionEscalated("sess-1")).toBe(false);
  });

  it("pins an escalated session: the next step goes straight to strong", async () => {
    scriptExecutor([{ status: 429 }, { ok: true }]);
    await handleChat(chatRequest(explorationRequest("sticky-1")));
    expect(dispatches).toHaveLength(2);

    dispatches.length = 0;
    scriptExecutor([{ ok: true }]);
    const res = await handleChat(chatRequest(explorationRequest("sticky-1")));
    expect(res.status).toBe(200);
    expect(dispatches).toEqual([
      expect.objectContaining({ model: "claude-sonnet-4-6", routeKind: CASCADE_ROUTE_KINDS.strong, attempt: 1 }),
    ]);
  });

  it("does not pin a different session on the same model", async () => {
    scriptExecutor([{ status: 429 }, { ok: true }]);
    await handleChat(chatRequest(explorationRequest("sticky-2")));

    dispatches.length = 0;
    scriptExecutor([{ ok: true }]);
    await handleChat(chatRequest(explorationRequest("other-session")));
    expect(dispatches[0].routeKind).toBe(CASCADE_ROUTE_KINDS.cheap);
  });

  it("never mutates the caller's request body across the escalation", async () => {
    scriptExecutor([{ status: 503 }, { ok: true }]);
    const body = explorationRequest("immut-1");
    const snapshot = structuredClone(body);
    const res = await handleChat(chatRequest(body), null, { body });
    expect(res.status).toBe(200);
    expect(dispatches).toHaveLength(2);
    expect(body).toEqual(snapshot);
    expect(body.model).toBe(STRONG);
  });
});
