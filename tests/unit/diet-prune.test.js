// AgentDiet-style expired tool-result pruning (task 3): open-sse/utils/dietPrune.js
// module contract plus the chatCore wiring gate. Module tests cover expired
// pruning, verbatim/id reference safety, error-trace and diff-hunk gates, the
// epoch-prefix boundary, pair structure, duplicate retention, and shape
// tolerance. Wiring tests drive handleChatCore with a mocked executor (no
// network) and assert default-off behavior, the applied path, and truthful
// telemetry rows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pruneExpiredToolResults } from "open-sse/utils/dietPrune.js";
import { appendTokenSaverEvent, __setTokenSaverEventsDirForTest } from "@/lib/tokenSaver/events.js";

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

// ---- fixtures ---------------------------------------------------------------

function trUser(toolUseId, content, extra = {}) {
  return {
    role: "user",
    content: [
      { type: "text", text: "run" },
      { type: "tool_result", tool_use_id: toolUseId, content, ...extra },
    ],
  };
}

function toolUseAssistant(toolUseId, name = "bash") {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name, input: {} }],
  };
}

function asst(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function user(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

// Head (indices 0-1, at/before the cut) + one tool_result + 9 assistant turns.
function agedMessages(toolResultContent, { toolUseId = "toolu_a", extra = {} } = {}) {
  const messages = [
    { role: "user", content: "head" },
    { role: "assistant", content: "a0" },
    trUser(toolUseId, toolResultContent, extra),
  ];
  for (let k = 0; k < 9; k++) {
    messages.push(user(`step ${k}`));
    messages.push(asst(`ok ${k}`));
  }
  return messages;
}

function findToolResult(messages, toolUseId) {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    const block = msg.content.find((b) => b?.type === "tool_result" && b.tool_use_id === toolUseId);
    if (block) return block;
  }
  return null;
}

// ---- module: gates ----------------------------------------------------------

describe("pruneExpiredToolResults", () => {
  it("skips with applied:false when the epoch cut is 0", () => {
    const messages = agedMessages("z".repeat(3000));
    const body = { messages };
    const res = pruneExpiredToolResults(body, { epochCutIndex: 0 });
    expect(res.applied).toBe(false);
    expect(res.skip).toBe("epoch_boundary");
    expect(res.messages).toBe(messages);
  });

  it("passes non-recognizable bodies through unchanged", () => {
    expect(pruneExpiredToolResults(null, { epochCutIndex: 1 }).applied).toBe(false);
    expect(pruneExpiredToolResults({}, { epochCutIndex: 1 }).applied).toBe(false);
    expect(pruneExpiredToolResults({ messages: "nope" }, { epochCutIndex: 1 }).applied).toBe(false);
  });

  it("prunes an expired, unreferenced tool_result to the expired stub", () => {
    const res = pruneExpiredToolResults(
      { messages: agedMessages("z".repeat(3000)) },
      { epochCutIndex: 1 },
    );
    expect(res.applied).toBe(true);
    expect(res.prunedBlocks).toBe(1);
    expect(res.prunedChars).toBe(3000);
    const block = findToolResult(res.messages, "toolu_a");
    expect(block.content).toBe("[pruned: 3000 chars — expired]");
  });

  it("keeps payloads below minBlockChars", () => {
    const res = pruneExpiredToolResults(
      { messages: agedMessages("z".repeat(100)) },
      { epochCutIndex: 1 },
    );
    expect(res.applied).toBe(false);
    expect(res.messages).toBeDefined();
  });

  it("keeps blocks younger than minAgeTurns assistant turns", () => {
    const messages = [
      { role: "user", content: "head" },
      { role: "assistant", content: "a0" },
      trUser("toolu_a", "z".repeat(3000)),
    ];
    for (let k = 0; k < 7; k++) {
      messages.push(user(`step ${k}`));
      messages.push(asst(`ok ${k}`));
    }
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1, minAgeTurns: 8 });
    expect(res.applied).toBe(false);
  });

  it("keeps a block a later assistant turn quotes verbatim (>=64-char substring)", () => {
    const quoted = "Q".repeat(100);
    const payload = "z".repeat(2900) + quoted;
    const messages = agedMessages(payload);
    // Rewrite one of the last 3 assistant turns to quote the payload.
    const lastAssistant = messages.length - 1;
    messages[lastAssistant] = asst(`as discussed: ${quoted} — see above`);
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1 });
    expect(res.applied).toBe(false);
    expect(findToolResult(res.messages, "toolu_a").content).toBe(payload);
  });

  it("keeps a block whose tool_use id a later assistant turn mentions", () => {
    const messages = agedMessages("z".repeat(3000), { toolUseId: "toolu_quote_me" });
    const lastAssistant = messages.length - 1;
    messages[lastAssistant] = asst("the output of toolu_quote_me was irrelevant");
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1 });
    expect(res.applied).toBe(false);
  });

  it("keeps error traces from failed tools (is_error + error text)", () => {
    const payload = `Error: boom\n${"e".repeat(3000)}`;
    const res = pruneExpiredToolResults(
      { messages: agedMessages(payload, { extra: { is_error: true } }) },
      { epochCutIndex: 1 },
    );
    expect(res.applied).toBe(false);
    expect(findToolResult(res.messages, "toolu_a").content).toBe(payload);
  });

  it("prunes error-text payloads when the tool did not report is_error", () => {
    const payload = `Error: boom\n${"e".repeat(3000)}`;
    const res = pruneExpiredToolResults(
      { messages: agedMessages(payload) },
      { epochCutIndex: 1 },
    );
    expect(res.applied).toBe(true);
  });

  it("keeps blocks carrying diff hunks", () => {
    const payload = `diff --git a/x b/x\n@@ -1,3 +1,4 @@\n${"d".repeat(3000)}`;
    const res = pruneExpiredToolResults(
      { messages: agedMessages(payload) },
      { epochCutIndex: 1 },
    );
    expect(res.applied).toBe(false);
  });

  it("keeps @@-only hunks too", () => {
    const payload = `@@ -1 +1 @@\n${"d".repeat(3000)}`;
    const res = pruneExpiredToolResults(
      { messages: agedMessages(payload) },
      { epochCutIndex: 1 },
    );
    expect(res.applied).toBe(false);
  });

  it("never mutates messages at or before the epoch cut", () => {
    const messages = agedMessages("z".repeat(3000));
    const frozen = deepFreeze(messages);
    const res = pruneExpiredToolResults({ messages: frozen }, { epochCutIndex: 1 });
    expect(res.applied).toBe(true);
    expect(res.messages[0]).toBe(frozen[0]);
    expect(res.messages[1]).toBe(frozen[1]);
  });

  it("never mutates blocks carrying cache_control", () => {
    const messages = agedMessages("z".repeat(3000));
    const block = findToolResult(messages, "toolu_a");
    block.cache_control = { type: "ephemeral" };
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1 });
    expect(res.applied).toBe(false);
  });

  it("keeps the most recent assistant turn's own tool_results", () => {
    const messages = [
      { role: "user", content: "head" },
      { role: "assistant", content: "a0" },
      trUser("toolu_a", "z".repeat(3000)),
      toolUseAssistant("toolu_live"),
      trUser("toolu_live", "y".repeat(3000)),
    ];
    const res = pruneExpiredToolResults(
      { messages },
      { epochCutIndex: 1, minAgeTurns: 1 },
    );
    // The old block prunes; the live turn's own result survives.
    expect(res.applied).toBe(true);
    expect(findToolResult(res.messages, "toolu_live").content).toBe("y".repeat(3000));
  });

  it("preserves pair structure: message count, block counts, id linkage, tool_use untouched", () => {
    const messages = [
      { role: "user", content: "head" },
      toolUseAssistant("toolu_a"),
      trUser("toolu_a", "z".repeat(3000)),
      toolUseAssistant("toolu_b"),
      trUser("toolu_b", "x".repeat(3000)),
      ...Array.from({ length: 18 }, (_, k) =>
        k % 2 === 0 ? user(`step ${k}`) : asst(`ok ${k}`),
      ),
    ];
    const before = JSON.stringify(messages);
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1 });
    expect(res.applied).toBe(true);
    expect(res.messages).toHaveLength(messages.length);
    res.messages.forEach((msg, i) => {
      const beforeBlocks = Array.isArray(messages[i].content) ? messages[i].content.length : 0;
      const afterBlocks = Array.isArray(msg.content) ? msg.content.length : 0;
      expect(afterBlocks).toBe(beforeBlocks);
    });
    const idsBefore = [...before.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => m[1]).sort();
    const idsAfter = JSON.stringify(res.messages).matchAll(/"tool_use_id":"([^"]+)"/g);
    expect([...idsAfter].map((m) => m[1]).sort()).toEqual(idsBefore);
    // tool_use blocks byte-identical.
    const toolUseBefore = JSON.stringify(
      messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b?.type === "tool_use"),
    );
    const toolUseAfter = JSON.stringify(
      res.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b?.type === "tool_use"),
    );
    expect(toolUseAfter).toBe(toolUseBefore);
  });

  it("prunes older duplicates and names the retained turn; newest copy survives", () => {
    const dup = "z".repeat(3000);
    const messages = [
      { role: "user", content: "head" },
      { role: "assistant", content: "a0" },
      trUser("toolu_a", dup),
      asst("mid"),
      trUser("toolu_b", dup),
      ...Array.from({ length: 18 }, (_, k) =>
        k % 2 === 0 ? user(`step ${k}`) : asst(`ok ${k}`),
      ),
    ];
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1 });
    expect(res.applied).toBe(true);
    expect(res.prunedBlocks).toBe(1);
    const older = findToolResult(res.messages, "toolu_a");
    const newest = findToolResult(res.messages, "toolu_b");
    expect(older.content).toMatch(/^\[pruned: 3000 chars, identical copy retained in turn \d+\]$/);
    expect(newest.content).toBe(dup);
  });

  it("prunes both duplicates' older copies when three identical payloads exist", () => {
    const dup = "z".repeat(3000);
    const messages = [
      { role: "user", content: "head" },
      { role: "assistant", content: "a0" },
      trUser("toolu_a", dup),
      asst("mid1"),
      trUser("toolu_b", dup),
      asst("mid2"),
      trUser("toolu_c", dup),
      ...Array.from({ length: 18 }, (_, k) =>
        k % 2 === 0 ? user(`step ${k}`) : asst(`ok ${k}`),
      ),
    ];
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1 });
    expect(res.prunedBlocks).toBe(2);
    expect(findToolResult(res.messages, "toolu_c").content).toBe(dup);
  });

  it("prunes OpenAI-style role:'tool' string messages", () => {
    const messages = [
      { role: "user", content: "head" },
      { role: "assistant", content: "a0", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "z".repeat(3000) },
      ...Array.from({ length: 18 }, (_, k) =>
        k % 2 === 0 ? { role: "user", content: `step ${k}` } : { role: "assistant", content: `ok ${k}` },
      ),
    ];
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1 });
    expect(res.applied).toBe(true);
    const toolMsg = res.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("[pruned: 3000 chars — expired]");
    expect(toolMsg.tool_call_id).toBe("call_1");
  });

  it("skips unrecognized content shapes without throwing", () => {
    const messages = [
      { role: "user", content: "head" },
      { role: "assistant", content: "a0" },
      { role: "user", content: 42 },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "z".repeat(3000) }] },
      ...Array.from({ length: 18 }, (_, k) =>
        k % 2 === 0 ? user(`step ${k}`) : asst(`ok ${k}`),
      ),
    ];
    const res = pruneExpiredToolResults({ messages }, { epochCutIndex: 1 });
    expect(res.applied).toBe(true);
    expect(res.messages[2]).toBe(messages[2]);
  });
});

// ---- chatCore wiring ---------------------------------------------------------

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  dispatchedBodies: [],
}));

vi.mock("../../open-sse/utils/proxyFetch.js", async (orig) => ({
  ...(await orig()),
  proxyAwareFetch: vi.fn(async () => {
    throw new Error("no test in this file may reach an upstream");
  }),
  installGlobalProxyFetch: vi.fn(),
}));

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

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function executorResult() {
  return {
    response: new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        object: "chat.completion",
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    transformedBody: null,
  };
}

const MODEL = "claude-opus-5";
const PROVIDER = "anthropic";

function claudeBody(rest, { systemChars = 4000, headChars = 2000 } = {}) {
  return {
    model: `${PROVIDER}/${MODEL}`,
    stream: false,
    max_tokens: 100,
    system: "sys ".repeat(Math.ceil(systemChars / 4)),
    messages: [
      { role: "user", content: "head ".repeat(Math.ceil(headChars / 5)) },
      ...rest,
    ],
  };
}

// Shared head (assistant + divergent user) then a tool_result older than 8
// assistant turns: the tool_use partner, the payload, and 9 user/assistant
// rounds so the age gate passes and the last 3 assistant turns ("ok 7/8/9"
// style short text) carry no verbatim reuse of the payload.
function dietTail() {
  return [
    { role: "assistant", content: "shared asst " + "s".repeat(900) },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_d", name: "bash", input: {} }] },
    {
      role: "user",
      content: [
        { type: "text", text: "run" },
        { type: "tool_result", tool_use_id: "toolu_d", content: "z".repeat(3000) },
      ],
    },
    ...Array.from({ length: 9 }, (_, k) => ({
      role: "user",
      content: [{ type: "text", text: `step ${k}` }],
    })).flatMap((u, k) => [u, { role: "assistant", content: [{ type: "text", text: `ok ${k}` }] }]),
  ];
}

function baseArgs(overrides = {}) {
  return {
    body: claudeBody(dietTail()),
    modelInfo: { provider: PROVIDER, model: MODEL },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      line: vi.fn(),
      tagForSession: () => "TAG",
      nextTag: () => "TAG",
      fmtThink: () => null,
    },
    connectionId: "conn-diet-1",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    clientRawRequest: { headers: {}, body: {} },
    onTokenSaverEvent: appendTokenSaverEvent,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatchedBodies.length = 0;
  mocks.executeMock.mockImplementation(async (args) => {
    mocks.dispatchedBodies.push(args?.body);
    return executorResult();
  });
});

describe("chatCore diet wiring", () => {
  // Two-request dance per test: the first primes the session's epoch entry,
  // the second diverges after a shared head, giving a nonzero cut. The diet
  // region (tool_result + tail) sits entirely below the cut.
  async function runSession({ firstBody, secondBody, overrides = {}, sid = "d1e7s1d" }) {
    await handleChatCore(baseArgs({ body: firstBody, sid, ...overrides }));
    await handleChatCore(baseArgs({ body: secondBody, sid, ...overrides }));
    return mocks.dispatchedBodies.at(-1);
  }

  function history(divergentUser) {
    return claudeBody([
      { role: "assistant", content: "shared asst " + "s".repeat(900) },
      divergentUser,
      ...dietTail().slice(1),
    ]);
  }

  const first = () => history({ role: "user", content: "filler " + "f".repeat(13000) });
  const second = () => history({ role: "user", content: "brand new " + "n".repeat(8000) });

  function findDietToolResult(dispatched) {
    for (const msg of dispatched.messages) {
      if (!Array.isArray(msg.content)) continue;
      const block = msg.content.find((b) => b?.type === "tool_result" && b.tool_use_id === "toolu_d");
      if (block) return block;
    }
    return null;
  }

  it("leaves tool_results untouched by default (flag off)", async () => {
    const dispatched = await runSession({ firstBody: first(), secondBody: second() });
    const block = findDietToolResult(dispatched);
    expect(block).toBeTruthy();
    expect(block.content).toBe("z".repeat(3000));
    expect(mocks.executeMock).toHaveBeenCalledTimes(2);
  });

  it("prunes expired tool_results below the cut when diet is on", async () => {
    const dispatched = await runSession({
      firstBody: first(),
      secondBody: second(),
      overrides: { dietEnabled: true },
    });
    // The epoch region (the shared head) is byte-identical to the first
    // request's dispatched messages.
    const firstDispatched = mocks.dispatchedBodies.at(-2);
    expect(JSON.stringify(dispatched.messages[0])).toBe(JSON.stringify(firstDispatched.messages[0]));
    expect(JSON.stringify(dispatched.messages[1])).toBe(JSON.stringify(firstDispatched.messages[1]));
    const block = findDietToolResult(dispatched);
    expect(block).toBeTruthy();
    expect(block.content).toBe("[pruned: 3000 chars — expired]");
    // Pair structure survives: the tool_use partner keeps its id.
    const toolUse = dispatched.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b?.type === "tool_use" && b.id === "toolu_d");
    expect(toolUse).toBeTruthy();
  });

  it("keeps referenced tool_results (assistant quotes a long substring)", async () => {
    const quoted = "Q".repeat(100);
    const tail = dietTail();
    tail[2] = {
      role: "user",
      content: [
        { type: "text", text: "run" },
        { type: "tool_result", tool_use_id: "toolu_d", content: "z".repeat(2900) + quoted },
      ],
    };
    const last = tail.length - 1;
    tail[last] = { role: "assistant", content: [{ type: "text", text: `final answer quotes ${quoted} verbatim` }] };
    const build = (divergent) => claudeBody([
      { role: "assistant", content: "shared asst " + "s".repeat(900) },
      divergent,
      ...tail.slice(1),
    ]);
    const dispatched = await runSession({
      firstBody: build({ role: "user", content: "filler " + "f".repeat(13000) }),
      secondBody: build({ role: "user", content: "brand new " + "n".repeat(8000) }),
      overrides: { dietEnabled: true },
    });
    const block = findDietToolResult(dispatched);
    expect(block.content).toBe("z".repeat(2900) + quoted);
  });

  async function readDietRows(name, fn) {
    const eventsDir = `/tmp/tokenproxy-diet-events-${process.pid}-${name}`;
    __setTokenSaverEventsDirForTest(eventsDir);
    let rows;
    try {
      await fn();
      const { readTokenSaverEvents } = await import("@/lib/tokenSaver/events.js");
      rows = readTokenSaverEvents().filter((r) => r.saver === "diet");
    } finally {
      __setTokenSaverEventsDirForTest(null);
    }
    return rows;
  }

  it("emits an applied:true diet row with truthful byte savings", async () => {
    const rows = await readDietRows("applied", async () => {
      await runSession({
        firstBody: first(),
        secondBody: second(),
        overrides: { dietEnabled: true },
      });
    });
    const applied = rows.find((r) => r.applied === true);
    expect(applied).toBeTruthy();
    expect(applied.bytesSaved).toBeLessThan(0);
    expect(typeof applied.ce).toBe("number");
  });

  it("emits a truthful applied:false row when the epoch boundary blocks the stage", async () => {
    const rows = await readDietRows("boundary", async () => {
      await runSession({
        firstBody: first(),
        secondBody: second(),
        overrides: { dietEnabled: true },
      });
      // Third request identical to the second: fully stable epoch (ce >=
      // prevBytes * 0.5), so the enabled stage must skip and say why.
      await handleChatCore(
        baseArgs({ body: second(), sid: "d1e7s1d", dietEnabled: true }),
      );
    });
    expect(rows.length).toBeGreaterThan(0);
    const skipped = rows.find((r) => r.applied === false);
    expect(skipped).toBeTruthy();
    expect(skipped.reason).toBe("epoch_boundary");
  });

  it("accepts diet events through the events allowlist", async () => {
    const rows = await readDietRows("allowlist", async () => {
      appendTokenSaverEvent({ saver: "diet", applied: false, reason: "epoch_boundary" });
      appendTokenSaverEvent({ saver: "diet", applied: true, bytesSaved: -200 });
    });
    expect(rows.find((r) => r.applied === false && r.reason === "epoch_boundary")).toBeTruthy();
    expect(rows.find((r) => r.applied === true)).toBeTruthy();
  });
});
