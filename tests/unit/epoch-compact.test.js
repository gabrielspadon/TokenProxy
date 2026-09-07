// Epoch-aligned compaction cascade (task 2): open-sse/utils/epochCompact.js
// module contract plus the chatCore wiring gate. Module tests cover
// epoch-region immutability, stub boundaries, pair-structure and
// cache_control preservation, the 75% window trigger, and the deterministic
// placeholder summarizer. Wiring tests drive handleChatCore with a mocked
// executor (no network) and assert the default-off behavior, the applied
// path, and the truthful skip telemetry row.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  microcompact,
  autocompact,
  computeEpochCutIndex,
  placeholderEpochSummarizer,
} from "open-sse/utils/epochCompact.js";
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

// ---- Anthropic-style fixtures ------------------------------------------------

function toolResultUser(chars, { toolUseId = "toolu_1", text = "run it" } = {}) {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "tool_result", tool_use_id: toolUseId, content: "x".repeat(chars) },
    ],
  };
}

function toolUseAssistant(toolUseId = "toolu_1", name = "bash") {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id: toolUseId, name, input: { command: "ls" } },
      { type: "text", text: "done" },
    ],
  };
}

function textUser(chars) {
  return { role: "user", content: [{ type: "text", text: "u".repeat(chars) }] };
}

function textAssistant(chars) {
  return { role: "assistant", content: [{ type: "text", text: "a".repeat(chars) }] };
}

describe("computeEpochCutIndex", () => {
  const messages = [textUser(100), textAssistant(100), textUser(100), textAssistant(100)];
  const bytesOf = (msgs) => msgs.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0);
  const msg0Bytes = Buffer.byteLength(JSON.stringify(messages[0]));

  it("returns 0 for a stable epoch (ce >= prevBytes * 0.5)", () => {
    expect(computeEpochCutIndex(messages, { ce: 800, prevBytes: 1000 })).toBe(0);
    expect(computeEpochCutIndex(messages, { ce: 500, prevBytes: 1000 })).toBe(0);
  });

  it("returns 0 when ce or prevBytes is missing/non-finite", () => {
    expect(computeEpochCutIndex(messages, {})).toBe(0);
    expect(computeEpochCutIndex(messages, { ce: Number.NaN, prevBytes: 100 })).toBe(0);
    expect(computeEpochCutIndex(messages, { ce: 10, prevBytes: 0 })).toBe(0);
    expect(computeEpochCutIndex(null, { ce: 10, prevBytes: 100 })).toBe(0);
  });

  it("returns the first index whose cumulative bytes exceed ce", () => {
    const total = bytesOf(messages);
    const ce = msg0Bytes + 10; // inside message 1
    expect(total).toBeGreaterThan(ce * 2); // keep the epoch unstable
    expect(computeEpochCutIndex(messages, { ce, prevBytes: total })).toBe(1);
    const ce0 = 5; // inside message 0
    expect(computeEpochCutIndex(messages, { ce: ce0, prevBytes: total })).toBe(0);
  });

  it("returns the last index when only the final message falls outside the prefix", () => {
    const total = bytesOf(messages);
    expect(computeEpochCutIndex(messages, { ce: total - 1, prevBytes: total * 4 })).toBe(3);
  });
});

describe("microcompact", () => {
  it("returns the input reference when nothing is eligible", () => {
    const body = { messages: [textUser(10), textAssistant(10), textUser(10), textAssistant(10)] };
    const res = microcompact(body, { epochCutIndex: 1, minBlockChars: 500, keepLastTurns: 1 });
    expect(res.applied).toBe(false);
    expect(res.messages).toBe(body.messages);
  });

  it("passes non-recognizable bodies through unchanged", () => {
    expect(microcompact(null, {}).applied).toBe(false);
    expect(microcompact({}, {}).applied).toBe(false);
    expect(microcompact({ messages: "nope" }, {}).applied).toBe(false);
  });

  it("does nothing when cut 0 leaves no mutable window", () => {
    const body = { messages: [toolResultUser(5000), toolUseAssistant()] };
    const res = microcompact(body, { epochCutIndex: 0, keepLastTurns: 0 });
    expect(res.applied).toBe(false);
    expect(res.messages).toBe(body.messages);
  });

  it("never touches messages at or before the epoch cut", () => {
    const messages = [
      toolResultUser(5000, { toolUseId: "toolu_a" }),
      toolUseAssistant("toolu_a"),
      toolResultUser(5000, { toolUseId: "toolu_b" }),
      toolUseAssistant("toolu_b"),
      textUser(20),
      textAssistant(20),
    ];
    const frozen = deepFreeze(messages);
    const res = microcompact(
      { messages: frozen },
      { epochCutIndex: 1, minBlockChars: 500, keepLastTurns: 2 },
    );
    expect(res.applied).toBe(true);
    // Indices 0..1 (the epoch region) are shared by reference, untouched.
    expect(res.messages[0]).toBe(frozen[0]);
    expect(res.messages[1]).toBe(frozen[1]);
    // Index 2 is mutable: its tool_result stubs.
    expect(res.messages[2].content[1].content).toContain("[cleared 5000 chars");
    expect(res.messages[2].content[1].tool_use_id).toBe("toolu_b");
    // Index 3 is the assistant tool_use partner: never stubbed.
    expect(res.messages[3]).toBe(frozen[3]);
    // The tail survives verbatim.
    expect(res.messages[4]).toBe(frozen[4]);
    expect(res.messages[5]).toBe(frozen[5]);
    expect(messages[0].content[1].content).toHaveLength(5000);
  });

  it("stubs a tool_result payload at exactly minBlockChars and preserves pair structure", () => {
    const big = "x".repeat(500);
    const messages = [
      textUser(10),
      textAssistant(10),
      toolResultUser(499, { toolUseId: "toolu_s" }), // just under: untouched
      toolUseAssistant("toolu_s"),
      toolResultUser(500, { toolUseId: "toolu_t" }), // at the floor: stubbed
      toolUseAssistant("toolu_t"),
    ];
    const res = microcompact(
      { messages },
      { epochCutIndex: 0, minBlockChars: 500, keepLastTurns: 1 },
    );
    expect(res.applied).toBe(true);
    expect(res.clearedBlocks).toBe(1);
    expect(res.clearedChars).toBe(500);
    // The under-floor tool_result survives by reference.
    expect(res.messages[2]).toBe(messages[2]);
    // The stubbed block keeps type, tool_use_id, and position; only the
    // payload collapses to the stub text.
    const block = res.messages[4].content[1];
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("toolu_t");
    expect(block.content).toBe(`[cleared ${big.length} chars — re-run the command if needed]`);
    expect(res.messages[4].content).toHaveLength(2);
    expect(res.messages[4].content[0]).toBe(messages[4].content[0]);
  });

  it("stubs Anthropic text blocks and OpenAI-style string content", () => {
    const messages = [
      textUser(10),
      textAssistant(10),
      textUser(700), // Anthropic blocks
      { role: "user", content: "s".repeat(600) }, // OpenAI-style string
      { role: "assistant", content: "keep me, assistant text is not stubbed".repeat(20) },
      { role: "tool", content: "t".repeat(550), tool_call_id: "call_1" }, // OpenAI tool result
      textUser(10),
    ];
    const res = microcompact(
      { messages },
      { epochCutIndex: 1, minBlockChars: 500, keepLastTurns: 1 },
    );
    expect(res.applied).toBe(true);
    expect(res.messages[2].content[0].text).toBe("[cleared 700 chars — re-run the command if needed]");
    expect(res.messages[3].content).toBe("[cleared 600 chars — re-run the command if needed]");
    expect(res.messages[4]).toBe(messages[4]);
    expect(res.messages[5].content).toBe("[cleared 550 chars — re-run the command if needed]");
    expect(res.messages[5].tool_call_id).toBe("call_1");
    expect(res.messages[6]).toBe(messages[6]);
  });

  it("leaves cache_control markers alone", () => {
    const messages = [
      textUser(10),
      {
        role: "user",
        content: [
          { type: "text", text: "c".repeat(900), cache_control: { type: "ephemeral" } },
        ],
      },
      textUser(10),
    ];
    const res = microcompact(
      { messages },
      { epochCutIndex: 0, minBlockChars: 500, keepLastTurns: 1 },
    );
    expect(res.applied).toBe(false);
    expect(res.messages).toBe(messages);
  });

  it("protects the last keepLastTurns messages", () => {
    const messages = [
      textUser(10),
      toolResultUser(5000),
      toolUseAssistant(),
      textUser(800),
      textAssistant(900),
    ];
    const res = microcompact(
      { messages },
      { epochCutIndex: 0, minBlockChars: 500, keepLastTurns: 3 },
    );
    expect(res.applied).toBe(true);
    expect(res.messages).toHaveLength(5);
    // Only index 1 is both mutable and outside the 3-message tail.
    expect(res.messages[1].content[1].content).toContain("[cleared 5000 chars");
    expect(res.messages[3]).toBe(messages[3]);
    expect(res.messages[4]).toBe(messages[4]);
  });
});

describe("autocompact", () => {
  const summarizeFn = async (dropped) => `SUMMARY of ${dropped.length} turns`;

  function history(n) {
    const messages = [];
    for (let i = 0; i < n; i++) {
      messages.push({ role: "user", content: `turn ${i}` });
      messages.push({ role: "assistant", content: `reply ${i}` });
    }
    return messages;
  }

  it("returns the input reference below the 75% trigger", async () => {
    const body = { messages: history(4) };
    const res = await autocompact(body, {
      windowTokens: 1000,
      usedTokens: 749,
      summarizeFn,
      epochCutIndex: 0,
      keepRecentTurns: 2,
    });
    expect(res.applied).toBe(false);
    expect(res.messages).toBe(body.messages);
  });

  it("returns the input reference when windowTokens is unusable", async () => {
    const body = { messages: history(4) };
    for (const windowTokens of [0, Number.NaN, null, undefined]) {
      const res = await autocompact(body, {
        windowTokens,
        usedTokens: 1e9,
        summarizeFn,
        epochCutIndex: 0,
        keepRecentTurns: 2,
      });
      expect(res.applied).toBe(false);
    }
  });

  it("fires at exactly 75% and replaces the dropped region with one synthetic summary", async () => {
    const messages = history(8);
    const res = await autocompact(
      { messages },
      {
        windowTokens: 1000,
        usedTokens: 750,
        summarizeFn,
        epochCutIndex: 1,
        keepRecentTurns: 3,
      },
    );
    expect(res.applied).toBe(true);
    expect(res.droppedTurns).toBe(16 - (1 + 1) - 3);
    expect(res.summary).toBe("SUMMARY of 11 turns");
    // messages[0..cut] survive verbatim, then the synthetic note, then tail.
    expect(res.messages[0]).toBe(messages[0]);
    expect(res.messages[1]).toBe(messages[1]);
    expect(res.messages[2]).toEqual({
      role: "user",
      content: "## Session summary (auto-compacted)\nSUMMARY of 11 turns",
    });
    expect(res.messages.slice(3)).toEqual(messages.slice(-3));
    expect(res.messages).toHaveLength(2 + 1 + 3);
  });

  it("does not mutate the frozen input", async () => {
    const frozen = deepFreeze(history(6));
    const res = await autocompact(
      { messages: frozen },
      { windowTokens: 100, usedTokens: 80, summarizeFn, epochCutIndex: 0, keepRecentTurns: 2 },
    );
    expect(res.applied).toBe(true);
    expect(frozen).toHaveLength(12);
    expect(res.messages[0]).toBe(frozen[0]);
  });

  it("returns unchanged when there is nothing between the cut and the tail", async () => {
    const body = { messages: history(3) };
    const res = await autocompact(body, {
      windowTokens: 100,
      usedTokens: 90,
      summarizeFn,
      epochCutIndex: 0,
      keepRecentTurns: 5,
    });
    expect(res.applied).toBe(false);
    expect(res.messages).toBe(body.messages);
  });

  it("fails closed when summarizeFn throws or returns no text", async () => {
    const body = { messages: history(8) };
    const opts = { windowTokens: 100, usedTokens: 90, epochCutIndex: 0, keepRecentTurns: 2 };
    const threw = await autocompact(body, {
      ...opts,
      summarizeFn: async () => {
        throw new Error("provider down");
      },
    });
    expect(threw.applied).toBe(false);
    expect(threw.messages).toBe(body.messages);
    const empty = await autocompact(body, { ...opts, summarizeFn: async () => "   " });
    expect(empty.applied).toBe(false);
  });
});

describe("placeholderEpochSummarizer", () => {
  it("builds a deterministic digest without a network call", () => {
    const dropped = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "read src/lib/a.js" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "src/lib/b.js" } },
          { type: "text", text: "wrote tests/unit/x.test.js" },
        ],
      },
      { role: "user", content: "look at src/app/main.ts" },
    ];
    const first = placeholderEpochSummarizer(dropped);
    expect(first).toBe(placeholderEpochSummarizer(dropped));
    expect(first).toContain("Turns dropped: 3");
    expect(first).toContain("Tools used: read_file");
    expect(first).toMatch(/Files seen: .*src\/lib\/a\.js/);
    expect(first).toContain("src/lib/b.js");
    expect(first).toContain("src/app/main.ts");
  });

  it("omits sections that have no entries", () => {
    const summary = placeholderEpochSummarizer([{ role: "user", content: "hi" }]);
    expect(summary).toBe("Turns dropped: 1");
    expect(summary).not.toContain("Tools used");
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

// A Claude-format body whose first user turn is the stable epoch head: the
// second request of a session keeps system + messages[0] identical and
// diverges after, giving a nonzero cut inside the messages array.
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

function mutableTail() {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "run" },
        { type: "tool_result", tool_use_id: "toolu_w", content: "z".repeat(3000) },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_w", name: "bash", input: {} }] },
    { role: "user", content: "tail one" },
    { role: "assistant", content: "tail two" },
    { role: "user", content: "tail three" },
  ];
}

function baseArgs(overrides = {}) {
  return {
    body: claudeBody(mutableTail()),
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
    connectionId: "conn-epoch-1",
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

describe("chatCore epoch cascade wiring", () => {
  // Two-request dance per test: the first primes the session's epoch entry,
  // the second diverges after a shared head (user + assistant) and exercises
  // the stages. Consecutive user messages merge in translation, so the shared
  // head is bracketed by an assistant turn to keep the epoch boundary inside
  // the messages array.
  async function runSession({ firstBody, secondBody, overrides = {}, sid = "ep0chs1d" }) {
    await handleChatCore(baseArgs({ body: firstBody, sid, ...overrides }));
    await handleChatCore(baseArgs({ body: secondBody, sid, ...overrides }));
    return mocks.dispatchedBodies.at(-1);
  }

  function claudeHistory(divergentUser) {
    return claudeBody([
      { role: "assistant", content: "shared asst " + "s".repeat(900) },
      divergentUser,
      { role: "assistant", content: "brand new reply" },
      ...mutableTail(),
    ]);
  }

  const first = () => claudeHistory({ role: "user", content: "filler " + "f".repeat(13000) });
  const second = () => claudeHistory({ role: "user", content: "brand new " + "n".repeat(8000) });

  function findToolResult(dispatched) {
    for (const msg of dispatched.messages) {
      if (!Array.isArray(msg.content)) continue;
      const block = msg.content.find((b) => b?.type === "tool_result" && b.tool_use_id === "toolu_w");
      if (block) return block;
    }
    return null;
  }

  it("leaves messages untouched by default (flags off)", async () => {
    const dispatched = await runSession({ firstBody: first(), secondBody: second() });
    const toolResult = findToolResult(dispatched);
    expect(toolResult).toBeTruthy();
    expect(toolResult.content).toBe("z".repeat(3000));
    expect(mocks.executeMock).toHaveBeenCalledTimes(2);
  });

  it("stubs tool_result payloads below the cut when epochMicro is on", async () => {
    const dispatched = await runSession({
      firstBody: first(),
      secondBody: second(),
      overrides: { epochMicroEnabled: true },
    });
    // The epoch region (the shared head) is byte-identical to the first
    // request's dispatched messages.
    const firstDispatched = mocks.dispatchedBodies.at(-2);
    expect(JSON.stringify(dispatched.messages[0])).toBe(JSON.stringify(firstDispatched.messages[0]));
    expect(JSON.stringify(dispatched.messages[1])).toBe(JSON.stringify(firstDispatched.messages[1]));
    // Below the cut the tool_result payload is stubbed; pair structure
    // (type, tool_use_id) survives.
    const toolResult = findToolResult(dispatched);
    expect(toolResult).toBeTruthy();
    expect(toolResult.content).toBe("[cleared 3000 chars — re-run the command if needed]");
    // The tool_use partner survives with its id intact.
    const toolUse = dispatched.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b?.type === "tool_use" && b.id === "toolu_w");
    expect(toolUse).toBeTruthy();
    // The live tail survives verbatim.
    const last = dispatched.messages.at(-1);
    expect(last.content?.[0]?.text ?? last.content).toBe("tail three");
  });

  async function readEpochRows(name, saver, fn) {
    const eventsDir = `/tmp/tokenproxy-epoch-events-${process.pid}-${name}`;
    __setTokenSaverEventsDirForTest(eventsDir);
    let rows;
    try {
      await fn();
      const { readTokenSaverEvents } = await import("@/lib/tokenSaver/events.js");
      rows = readTokenSaverEvents().filter((r) => r.saver === saver);
    } finally {
      __setTokenSaverEventsDirForTest(null);
    }
    return rows;
  }

  it("emits a truthful applied:false row when the epoch boundary blocks the stage", async () => {
    const rows = await readEpochRows("boundary", "epochMicro", async () => {
      await runSession({
        firstBody: first(),
        secondBody: second(),
        overrides: { epochMicroEnabled: true },
      });
      // Third request identical to the second: the epoch is fully stable
      // (ce >= prevBytes * 0.5), so the enabled stage must skip and say why.
      await handleChatCore(
        baseArgs({ body: second(), sid: "ep0chs1d", epochMicroEnabled: true }),
      );
    });
    expect(rows.length).toBeGreaterThan(0);
    const skipped = rows.find((r) => r.applied === false);
    expect(skipped).toBeTruthy();
    expect(skipped.reason).toBe("epoch_boundary");
  });

  it("skips epochAuto below the window trigger and reports window_pressure", async () => {
    let dispatched;
    const rows = await readEpochRows("pressure", "epochAuto", async () => {
      dispatched = await runSession({
        firstBody: first(),
        secondBody: second(),
        overrides: { epochAutoEnabled: true },
      });
    });
    expect(rows.length).toBeGreaterThan(0);
    const skipped = rows.find((r) => r.applied === false);
    expect(skipped).toBeTruthy();
    expect(skipped.reason).toBe("window_pressure");
    // And the body was not compacted.
    expect(
      dispatched.messages.some(
        (m) => typeof m.content === "string" && m.content.startsWith("## Session summary"),
      ),
    ).toBe(false);
  });

  it("accepts epochMicro/epochAuto events through the events allowlist", async () => {
    const rows = await readEpochRows("allowlist", "epochMicro", async () => {
      appendTokenSaverEvent({ saver: "epochMicro", applied: false, reason: "epoch_boundary" });
      appendTokenSaverEvent({ saver: "epochAuto", applied: false, reason: "window_pressure" });
      appendTokenSaverEvent({ saver: "epochMicro", applied: true, bytesSaved: -100 });
    }).then((microRows) =>
      readEpochRows("allowlist", "epochAuto", async () => {}).then(
        (autoRows) => [...microRows, ...autoRows],
      ),
    );
    expect(rows.find((r) => r.saver === "epochMicro" && r.reason === "epoch_boundary")).toBeTruthy();
    expect(rows.find((r) => r.saver === "epochAuto" && r.reason === "window_pressure")).toBeTruthy();
    expect(rows.find((r) => r.saver === "epochMicro" && r.applied === true)).toBeTruthy();
  });
});
